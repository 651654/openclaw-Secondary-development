#!/usr/bin/env python3
"""Cascade bridge: 0.8B vision decision signals -> 7B text decision.

Two modes:
  1) perception: call local PlayJev /v1/systemone (or in-process model) to score
     candidate visual options, then package a structured state for the 7B model.
  2) dry-run: synthesize the same envelope without loading weights.

The 7B side expects an OpenAI-compatible chat completions endpoint (llama.cpp /
Ollama / vLLM). If --llm-url is omitted, the bridge only prints the envelope.

Examples:
  python bridge_vision_decision.py --image shot.jpg --dry-run
  python bridge_vision_decision.py --image shot.jpg --vision-url http://127.0.0.1:18732 \\
      --llm-url http://127.0.0.1:8080/v1 --llm-model qwen2.5-7b-instruct
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_CRITERIA = {
    "click_primary": "interact with the primary / highlighted control",
    "click_secondary": "interact with a secondary control",
    "type_input": "focus an input field and type",
    "scroll": "scroll to reveal more content",
    "wait": "wait; no safe action yet",
    "abort": "abort; unsafe or unknown state",
}


def _post_json(url: str, payload: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def encode_image(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    suffix = path.suffix.lower().lstrip(".") or "jpeg"
    mime = "jpeg" if suffix in {"jpg", "jpeg"} else suffix
    return f"data:image/{mime};base64,{b64}"


def vision_decide(vision_url: str, image_data_url: str, criteria: dict[str, str], instructions: str) -> dict[str, Any]:
    body = {
        "model": "playjev-0.8b",
        "state": {"frames": [image_data_url]},
        "questions": {
            "next_action": {
                "type": "choice",
                "instructions": instructions,
                "criteria": criteria,
            }
        },
    }
    return _post_json(vision_url.rstrip("/") + "/v1/systemone", body)


def build_envelope(
    *,
    image_path: Path,
    vision: dict[str, Any] | None,
    criteria: dict[str, str],
    goal: str,
) -> dict[str, Any]:
    """Readable signal contract for the 7B decision model."""
    answer = None
    timing = None
    if vision:
        answer = vision.get("answers", {}).get("next_action")
        timing = vision.get("timing")

    ranked = []
    if answer and isinstance(answer.get("probabilities"), dict):
        ranked = sorted(answer["probabilities"].items(), key=lambda kv: kv[1], reverse=True)

    return {
        "schema": "openclaw.vision_cascade.v1",
        "goal": goal,
        "image": {"path": str(image_path), "note": "pixels consumed only by 0.8B; 7B sees this envelope"},
        "perception": {
            "model": (vision or {}).get("model", "dry-run"),
            "choice": None if not answer else answer.get("choice"),
            "confidence": None if not answer else answer.get("confidence"),
            "probabilities": None if not answer else answer.get("probabilities"),
            "ranked": [{"name": n, "p": p} for n, p in ranked],
            "timing": timing,
        },
        "action_space": [{"name": k, "description": v} for k, v in criteria.items()],
        "uncertainty": {
            "escalate_if_confidence_below": 0.35,
            "forbid_if_top_is": ["abort"],
            "notes": [
                "Treat perception.probabilities as uncalibrated option mass, not true confidence.",
                "If confidence is low, prefer wait/abort or escalate to a larger VLM.",
            ],
        },
        "decision_request": {
            "type": "choice",
            "instructions": (
                "You are the System Two planner. Using only the perception envelope and goal, "
                "choose exactly one action from action_space. Prefer wait/abort when confidence "
                "is low or the scene is ambiguous. Reply with JSON: "
                '{"action":"<name>","reason":"<short>","use_perception":true|false}'
            ),
        },
    }


def ask_llm(llm_url: str, model: str, envelope: dict[str, Any]) -> dict[str, Any]:
    messages = [
        {
            "role": "system",
            "content": "You are a careful automation planner. Output JSON only.",
        },
        {
            "role": "user",
            "content": json.dumps(envelope, ensure_ascii=False),
        },
    ]
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": 256,
    }
    # OpenAI-compatible chat completions
    return _post_json(llm_url.rstrip("/") + "/chat/completions", payload)


def main() -> int:
    p = argparse.ArgumentParser(description="0.8B vision -> 7B decision cascade bridge")
    p.add_argument("--image", type=Path, required=True)
    p.add_argument("--goal", default="Complete the visible UI task safely.")
    p.add_argument("--vision-url", default="http://127.0.0.1:18732")
    p.add_argument("--llm-url", default="", help="OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1")
    p.add_argument("--llm-model", default="qwen2.5-7b-instruct")
    p.add_argument("--dry-run", action="store_true", help="Skip vision/LLM HTTP calls; print envelope only")
    p.add_argument("--instructions", default="Which action should the agent take next on this screen?")
    args = p.parse_args()

    if not args.image.is_file():
        print(f"ERROR: image not found: {args.image}", file=sys.stderr)
        return 2

    criteria = dict(DEFAULT_CRITERIA)
    vision = None
    if not args.dry_run:
        try:
            vision = vision_decide(args.vision_url, encode_image(args.image), criteria, args.instructions)
        except urllib.error.URLError as e:
            print(f"ERROR: vision server unreachable at {args.vision_url}: {e}", file=sys.stderr)
            print("Hint: start it with small-model\\scripts\\serve_omnijev.ps1", file=sys.stderr)
            return 3

    envelope = build_envelope(image_path=args.image, vision=vision, criteria=criteria, goal=args.goal)
    print("=== perception envelope ===")
    print(json.dumps(envelope, ensure_ascii=False, indent=2))

    if args.dry_run or not args.llm_url:
        print("=== llm skipped (dry-run or no --llm-url) ===")
        return 0

    try:
        llm = ask_llm(args.llm_url, args.llm_model, envelope)
    except urllib.error.URLError as e:
        print(f"ERROR: llm unreachable at {args.llm_url}: {e}", file=sys.stderr)
        return 4

    print("=== llm response ===")
    print(json.dumps(llm, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
