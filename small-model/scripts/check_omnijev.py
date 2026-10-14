#!/usr/bin/env python3
"""Smoke-check local OmniJev/PlayJev-0.8B weights.

Loads the checkpoint from small-model/omnijev-0.8b, runs one decision on a
synthetic frame, and prints timing + probabilities.

Usage (from repo root, with the local venv):
  small-model\\.venv-omnijev\\Scripts\\python.exe small-model\\scripts\\check_omnijev.py
  small-model\\.venv-omnijev\\Scripts\\python.exe small-model\\scripts\\check_omnijev.py --device cpu --dtype float32
"""
from __future__ import annotations

import argparse
import io
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAYJEV_REPO = ROOT / "playjev"
CKPT_DEFAULT = ROOT / "omnijev-0.8b"


def main() -> int:
    p = argparse.ArgumentParser(description="Smoke-check local PlayJev-0.8B")
    p.add_argument("--ckpt", type=Path, default=CKPT_DEFAULT)
    p.add_argument("--device", default="cpu", help="cpu or cuda:0")
    p.add_argument("--dtype", default="float32", choices=["float32", "bfloat16", "float16"])
    p.add_argument("--long-side", type=int, default=448)
    args = p.parse_args()

    if not args.ckpt.is_dir():
        print(f"ERROR: checkpoint missing: {args.ckpt}", file=sys.stderr)
        return 2
    if not (args.ckpt / "model.safetensors").is_file():
        print(f"ERROR: model.safetensors missing under {args.ckpt}", file=sys.stderr)
        return 2
    if not PLAYJEV_REPO.is_dir():
        print(f"ERROR: PlayJev runtime missing: {PLAYJEV_REPO}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(PLAYJEV_REPO))
    from PIL import Image
    from playjev.model import PlayJevModel

    # Synthetic UI-like frame: colored panels stand in for a screenshot.
    img = Image.new("RGB", (640, 360), (32, 36, 48))
    for x0, color in ((40, (70, 130, 220)), (240, (220, 90, 70)), (440, (60, 180, 110))):
        for x in range(x0, x0 + 140):
            for y in range(140, 220):
                img.putpixel((x, y), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    frame = buf.getvalue()

    options = [
        {"name": "left", "description": "choose the left panel"},
        {"name": "center", "description": "choose the center panel"},
        {"name": "right", "description": "choose the right panel"},
        {"name": "none", "description": "no actionable control"},
    ]

    print(f"ckpt={args.ckpt}")
    print(f"device={args.device} dtype={args.dtype}")
    t0 = time.perf_counter()
    model = PlayJevModel(str(args.ckpt), device=args.device, dtype=args.dtype, template="plain").load()
    print(f"load_s={model.load_seconds:.2f}")

    t1 = time.perf_counter()
    decision = model.decide(
        [frame],
        options,
        instructions="Which panel should the agent act on next?",
        frames_per_state=1,
        long_side=args.long_side,
        batch_size=1,
    )[0]
    t2 = time.perf_counter()
    timing = model.last_timing

    print(f"choice={options[decision.choice]['name']}")
    print(f"confidence={decision.confidence:.4f}")
    print(f"allowed_mass={decision.allowed_mass:.4f}")
    print(f"top_token={decision.top_token!r}")
    print("probabilities=")
    for opt, prob in zip(options, decision.probs):
        print(f"  {opt['name']}: {prob:.4f}")
    print(
        f"timing prep_ms={timing.prep_s * 1000:.1f} "
        f"forward_ms={timing.forward_s * 1000:.1f} "
        f"wall_ms={(t2 - t1) * 1000:.1f} "
        f"visual_tokens={timing.visual_tokens} "
        f"input_tokens={timing.input_tokens}"
    )
    print(f"ok total_s={t2 - t0:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
