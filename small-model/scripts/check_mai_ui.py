"""CPU/CUDA smoke test for local Tongyi-MAI/MAI-UI-2B (Qwen3-VL GUI agent).

Loads the checkpoint under small-model/mai-ui-2b, runs one short multimodal
generation on a synthetic UI screenshot, and prints structured timing + text.

Usage:
  .\\.venv-mai-ui\\Scripts\\python.exe .\\scripts\\check_mai_ui.py
  .\\.venv-mai-ui\\Scripts\\python.exe .\\scripts\\check_mai_ui.py --device cpu --dtype float32 --max-new-tokens 64
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CKPT_DEFAULT = ROOT / "mai-ui-2b"
OUT_DEFAULT = ROOT / "scripts" / "_mai_ui_smoke.json"


def make_demo_ui(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (720, 1280), (245, 247, 250))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, 720, 96), fill=(32, 96, 200))
    draw.text((24, 32), "Mail", fill=(255, 255, 255))
    draw.rounded_rectangle((48, 180, 672, 300), radius=16, fill=(255, 255, 255), outline=(200, 200, 200))
    draw.text((72, 220), "Inbox", fill=(20, 20, 20))
    # Target control for grounding-style prompts
    draw.ellipse((560, 200, 640, 280), fill=(220, 60, 60))
    draw.text((575, 225), "@", fill=(255, 255, 255))
    draw.rounded_rectangle((48, 340, 672, 460), radius=16, fill=(255, 255, 255), outline=(200, 200, 200))
    draw.text((72, 380), "Settings", fill=(20, 20, 20))
    img.save(path, format="PNG")
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, default=CKPT_DEFAULT)
    ap.add_argument("--device", default="cpu", help="cpu | cuda:0 | auto")
    ap.add_argument("--dtype", default="float32", choices=("float32", "float16", "bfloat16"))
    ap.add_argument("--max-new-tokens", type=int, default=64)
    ap.add_argument("--image", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument(
        "--prompt",
        default=(
            "You are a GUI agent. Look at the screenshot and answer briefly: "
            "what is the red circular icon on the right of the Inbox row? "
            "Reply with one short sentence."
        ),
    )
    args = ap.parse_args()

    if not (args.ckpt / "config.json").is_file():
        raise SystemExit(f"missing checkpoint config: {args.ckpt}")
    weight = args.ckpt / "model.safetensors"
    if not weight.is_file() or weight.stat().st_size < 4_000_000_000:
        raise SystemExit(f"incomplete weights: {weight}")

    import torch
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

    dtype_map = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }
    dtype = dtype_map[args.dtype]
    device = args.device
    if device == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"

    image_path = args.image or (ROOT / "scripts" / "_mai_ui_demo.png")
    if args.image is None:
        make_demo_ui(image_path)

    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained(str(args.ckpt), trust_remote_code=True)
    t_proc = time.perf_counter()
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        str(args.ckpt),
        torch_dtype=dtype,
        trust_remote_code=True,
    )
    model.to(device)
    model.eval()
    t_load = time.perf_counter()

    image = Image.open(image_path).convert("RGB")
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": args.prompt},
            ],
        }
    ]
    # Prefer apply_chat_template when available
    if hasattr(processor, "apply_chat_template"):
        prompt_text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = processor(
            text=[prompt_text],
            images=[image],
            return_tensors="pt",
            padding=True,
        )
    else:
        inputs = processor(text=args.prompt, images=image, return_tensors="pt")

    inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}
    t_prep = time.perf_counter()

    with torch.inference_mode():
        out_ids = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
    t_gen = time.perf_counter()

    # Trim prompt tokens when possible
    prompt_len = inputs["input_ids"].shape[-1]
    gen_only = out_ids[:, prompt_len:]
    text = processor.batch_decode(gen_only, skip_special_tokens=True)[0].strip()
    t_end = time.perf_counter()

    result = {
        "ok": bool(text),
        "ckpt": str(args.ckpt),
        "device": device,
        "dtype": args.dtype,
        "cuda_available": bool(torch.cuda.is_available()),
        "image": str(image_path),
        "prompt": args.prompt,
        "text": text,
        "max_new_tokens": args.max_new_tokens,
        "timing_s": {
            "processor": round(t_proc - t0, 3),
            "load": round(t_load - t_proc, 3),
            "prep": round(t_prep - t_load, 3),
            "generate": round(t_gen - t_prep, 3),
            "total": round(t_end - t0, 3),
        },
        "weight_bytes": weight.stat().st_size,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
