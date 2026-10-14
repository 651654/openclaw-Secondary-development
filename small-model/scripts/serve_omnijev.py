#!/usr/bin/env python3
"""Serve local PlayJev-0.8B with configurable device/dtype (CPU-friendly)."""
from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAYJEV_REPO = ROOT / "playjev"
CKPT_DEFAULT = ROOT / "omnijev-0.8b"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", type=Path, default=CKPT_DEFAULT)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=18732)
    p.add_argument("--device", default="cpu")
    p.add_argument("--dtype", default="float32", choices=["float32", "bfloat16", "float16"])
    p.add_argument("--name", default="playjev-0.8b")
    p.add_argument("--two-frame", action="store_true")
    p.add_argument("--stack", default="temporal", choices=["temporal", "separate"])
    p.add_argument("--template", default="plain", choices=["plain", "chat"])
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    sys.path.insert(0, str(PLAYJEV_REPO))
    from playjev.model import PlayJevModel
    import playjev.serve as serve

    class Engine(serve.Engine):
        def __init__(self, ckpt, device, name, two_frame, stack, template):
            self.name, self.two_frame, self.stack = name, two_frame, stack
            self.m = PlayJevModel(
                ckpt, device=device, dtype=args.dtype, template=template
            ).load()
            self.lock = threading.Lock()

    serve.Engine = Engine
    sys.argv = [
        "playjev.serve",
        "--ckpt",
        str(args.ckpt),
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--device",
        args.device,
        "--name",
        args.name,
        "--stack",
        args.stack,
        "--template",
        args.template,
    ]
    if args.two_frame:
        sys.argv.append("--two-frame")
    if args.verbose:
        sys.argv.append("--verbose")
    os.environ.setdefault("PLAYJEV_DTYPE", args.dtype)
    serve.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
