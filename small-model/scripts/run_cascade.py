#!/usr/bin/env python3
"""Run the recommended cascade end-to-end on this host.

Flow:
  image -> PlayJev-0.8B (in-process System One) -> envelope -> Qwen2.5-7B GGUF (llama-cpp)
        -> gated final action

Does not require separate HTTP servers. Writes a JSON evidence file.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PLAYJEV_REPO = ROOT / "playjev"
CKPT_DEFAULT = ROOT / "omnijev-0.8b"
GGUF_DEFAULT = ROOT / "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"

DEFAULT_CRITERIA = {
    "click_primary": "interact with the primary / highlighted control",
    "click_secondary": "interact with a secondary control",
    "type_input": "focus an input field and type",
    "scroll": "scroll to reveal more content",
    "wait": "wait; no safe action yet",
    "abort": "abort; unsafe or unknown state",
}


def make_demo_image(path: Path) -> None:
    from PIL import Image

    img = Image.new("RGB", (640, 360), (32, 36, 48))
    for x0, color in ((40, (70, 130, 220)), (240, (220, 90, 70)), (440, (60, 180, 110))):
        for x in range(x0, x0 + 140):
            for y in range(140, 220):
                img.putpixel((x, y), color)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="JPEG", quality=90)


def vision_decide(ckpt: Path, device: str, dtype: str, frame_bytes: bytes, criteria: dict[str, str], instructions: str):
    import gc

    sys.path.insert(0, str(PLAYJEV_REPO))
    from playjev.model import PlayJevModel

    options = [{"name": k, "description": v} for k, v in criteria.items()]
    t0 = time.perf_counter()
    model = PlayJevModel(str(ckpt), device=device, dtype=dtype, template="plain").load()
    load_s = time.perf_counter() - t0
    d = model.decide(
        [frame_bytes],
        options,
        instructions=instructions,
        frames_per_state=1,
        long_side=448,
        batch_size=1,
    )[0]
    timing = model.last_timing
    result = {
        "model": "playjev-0.8b",
        "load_s": load_s,
        "choice": options[d.choice]["name"],
        "confidence": d.confidence,
        "allowed_mass": d.allowed_mass,
        "top_token": d.top_token,
        "probabilities": {o["name"]: p for o, p in zip(options, d.probs)},
        "timing": {
            "prep_ms": round(timing.prep_s * 1000, 1),
            "forward_ms": round(timing.forward_s * 1000, 1),
            "visual_tokens": timing.visual_tokens,
            "input_tokens": timing.input_tokens,
        },
    }
    # Free VRAM/RAM before loading the 7B GGUF in a sibling process.
    del model
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return result



def build_envelope(goal: str, image_path: Path, perception: dict[str, Any], criteria: dict[str, str]) -> dict[str, Any]:
    ranked = sorted(perception["probabilities"].items(), key=lambda kv: kv[1], reverse=True)
    return {
        "schema": "openclaw.vision_cascade.v1",
        "goal": goal,
        "image": {"path": str(image_path)},
        "perception": {
            "model": perception["model"],
            "choice": perception["choice"],
            "confidence": perception["confidence"],
            "allowed_mass": perception["allowed_mass"],
            "top_token": perception["top_token"],
            "probabilities": perception["probabilities"],
            "ranked": [{"name": n, "p": p} for n, p in ranked],
            "timing": perception["timing"],
            "load_s": perception["load_s"],
        },
        "action_space": [{"name": k, "description": v} for k, v in criteria.items()],
        "uncertainty": {
            "escalate_if_confidence_below": 0.35,
            "forbid_if_top_is": ["abort"],
            "notes": [
                "Treat perception.probabilities as uncalibrated option mass.",
                "If confidence is low or allowed_mass is near zero, prefer wait/abort.",
            ],
        },
        "decision_request": {
            "type": "choice",
            "instructions": (
                "You are the System Two planner. Using only the perception envelope and goal, "
                "choose exactly one action from action_space. Prefer wait/abort when confidence "
                "is low or the scene is ambiguous. Reply with JSON only: "
                '{"action":"<name>","reason":"<short>","use_perception":true|false}'
            ),
        },
    }


def apply_hard_gates(envelope: dict[str, Any]) -> dict[str, Any] | None:
    perc = envelope["perception"]
    conf = float(perc.get("confidence") or 0.0)
    mass = float(perc.get("allowed_mass") or 0.0)
    choice = perc.get("choice")
    thr = float(envelope["uncertainty"]["escalate_if_confidence_below"])
    forbid = set(envelope["uncertainty"].get("forbid_if_top_is") or [])

    if choice in forbid:
        return {
            "action": "abort",
            "reason": "hard-gate: perception top action is forbidden",
            "use_perception": True,
            "gated": True,
        }
    if mass < 1e-4:
        return {
            "action": "wait",
            "reason": "hard-gate: allowed_mass near zero (out-of-domain / weak answer slot)",
            "use_perception": True,
            "gated": True,
        }
    if conf < thr:
        return {
            "action": "wait",
            "reason": f"hard-gate: confidence {conf:.3f} < {thr}",
            "use_perception": True,
            "gated": True,
        }
    return None


def _parse_json_object(text: str) -> dict[str, Any] | None:
    """Parse the last valid JSON object (assistant answer after any echoed prompt)."""
    end = text.rfind("}")
    while end >= 0:
        start = text.rfind("{", 0, end + 1)
        while start >= 0:
            chunk = text[start : end + 1]
            try:
                obj = json.loads(chunk)
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                pass
            start = text.rfind("{", 0, start)
        end = text.rfind("}", 0, end)
    return None


def ask_7b_gguf(
    gguf: Path,
    envelope: dict[str, Any],
    n_threads: int,
    n_ctx: int,
    llama_cli: Path | None = None,
) -> dict[str, Any]:
    prompt = (
        "<|im_start|>system\nYou are a careful automation planner. Output JSON only.<|im_end|>\n"
        f"<|im_start|>user\n{json.dumps(envelope, ensure_ascii=False)}<|im_end|>\n"
        "<|im_start|>assistant\n"
    )

    # Prefer llama-cpp-python when installed; otherwise use bundled llama-cli.exe.
    try:
        from llama_cpp import Llama  # type: ignore

        t0 = time.perf_counter()
        llm = Llama(
            model_path=str(gguf),
            n_ctx=n_ctx,
            n_threads=n_threads,
            verbose=False,
        )
        load_s = time.perf_counter() - t0
        t1 = time.perf_counter()
        out = llm(
            prompt,
            max_tokens=256,
            temperature=0.1,
            stop=["<|im_end|>", "<|endoftext|>"],
        )
        infer_s = time.perf_counter() - t1
        text = out["choices"][0]["text"]
        return {
            "backend": "llama-cpp-python",
            "load_s": load_s,
            "infer_s": infer_s,
            "raw_text": text,
            "parsed": _parse_json_object(text),
            "usage": out.get("usage"),
        }
    except Exception as py_err:
        cli = llama_cli or (ROOT / "llama-cpp" / "llama-cli.exe")
        if not cli.is_file():
            raise RuntimeError(
                f"llama-cpp-python unavailable ({py_err!r}) and llama-cli missing: {cli}"
            ) from py_err

        import subprocess

        # Keep the prompt on an ASCII path; some llama-cli builds fail on non-ASCII TEMP dirs.
        prompt_path = ROOT / "scripts" / "_cascade_prompt.txt"
        prompt_path.write_text(prompt, encoding="utf-8")
        cmd = [
            str(cli),
            "-m",
            str(gguf),
            "-f",
            str(prompt_path),
            "-n",
            "256",
            "-c",
            str(n_ctx),
            "-t",
            str(n_threads),
            "--temp",
            "0.1",
            "--no-jinja",
            "-st",
            "--no-display-prompt",
        ]
        t0 = time.perf_counter()
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        elapsed = time.perf_counter() - t0
        combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
        # Drop banner / command help; keep the last JSON-looking assistant region.
        marker = "<|im_start|>assistant"
        raw = combined.split(marker)[-1] if marker in combined else combined
        return {
            "backend": "llama-cli",
            "cmd": cmd,
            "returncode": proc.returncode,
            "load_s": None,
            "infer_s": elapsed,
            "raw_text": raw[-4000:],
            "parsed": _parse_json_object(raw),
            "usage": None,
            "stderr_tail": (proc.stderr or "")[-2000:],
        }


def main() -> int:
    p = argparse.ArgumentParser(description="Recommended 0.8B->7B cascade runner")
    p.add_argument("--image", type=Path, default=ROOT / "scripts" / "_cascade_demo.jpg")
    p.add_argument("--make-demo-image", action="store_true")
    p.add_argument("--ckpt", type=Path, default=CKPT_DEFAULT)
    p.add_argument("--gguf", type=Path, default=GGUF_DEFAULT)
    p.add_argument("--device", default="cpu")
    p.add_argument("--dtype", default="float32")
    p.add_argument("--goal", default="Safely choose the next UI automation action.")
    p.add_argument("--n-threads", type=int, default=4)
    p.add_argument("--n-ctx", type=int, default=4096)
    p.add_argument("--llama-cli", type=Path, default=ROOT / "llama-cpp" / "llama-cli.exe")
    p.add_argument("--skip-7b", action="store_true")
    p.add_argument("--out", type=Path, default=ROOT / "scripts" / "_cascade_run.json")
    args = p.parse_args()

    if args.make_demo_image or not args.image.is_file():
        make_demo_image(args.image)

    frame = args.image.read_bytes()
    instructions = "Which action should the agent take next on this screen?"
    criteria = dict(DEFAULT_CRITERIA)

    print("== vision 0.8B ==")
    perception = vision_decide(args.ckpt, args.device, args.dtype, frame, criteria, instructions)
    print(json.dumps({k: perception[k] for k in ("choice", "confidence", "allowed_mass", "timing")}, indent=2))

    envelope = build_envelope(args.goal, args.image, perception, criteria)
    gated = apply_hard_gates(envelope)

    llm_result = None
    final = gated
    if args.skip_7b:
        print("== 7B skipped ==")
        if final is None:
            final = {
                "action": perception["choice"],
                "reason": "skip-7b: adopt perception choice",
                "use_perception": True,
                "gated": False,
            }
    else:
        if not args.gguf.is_file():
            print(f"ERROR: GGUF missing: {args.gguf}", file=sys.stderr)
            return 2
        print("== llm 7B ==")
        llm_result = ask_7b_gguf(
            args.gguf,
            envelope,
            args.n_threads,
            args.n_ctx,
            llama_cli=args.llama_cli,
        )
        print(json.dumps({"load_s": llm_result["load_s"], "infer_s": llm_result["infer_s"], "parsed": llm_result["parsed"]}, indent=2))
        if gated is not None:
            final = gated
        elif llm_result["parsed"] and isinstance(llm_result["parsed"].get("action"), str):
            action = llm_result["parsed"]["action"]
            if action not in criteria:
                final = {
                    "action": "wait",
                    "reason": f"llm action {action!r} not in action_space",
                    "use_perception": False,
                    "gated": True,
                }
            else:
                final = {
                    "action": action,
                    "reason": llm_result["parsed"].get("reason", ""),
                    "use_perception": bool(llm_result["parsed"].get("use_perception", True)),
                    "gated": False,
                }
        else:
            final = {
                "action": "wait",
                "reason": "llm did not return parseable JSON action",
                "use_perception": False,
                "gated": True,
            }

    evidence = {
        "schema": "openclaw.cascade_run.v1",
        "envelope": envelope,
        "hard_gate": gated,
        "llm": llm_result,
        "final": final,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print("== final ==")
    print(json.dumps(final, ensure_ascii=False, indent=2))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
