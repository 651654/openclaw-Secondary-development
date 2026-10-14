"""Probe whether Qwen-UI-Agent weights exist on Hugging Face."""
from __future__ import annotations

from huggingface_hub import model_info

CANDIDATES = [
    "Tongyi-MAI/Qwen-UI-Agent",
    "Tongyi-MAI/Qwen-UI-Agent-4B",
    "Tongyi-MAI/Qwen-UI-Agent-27B",
    "Tongyi-MAI/Qwen-UI-Agent-35B-A3B",
    "Qwen/Qwen-UI-Agent",
    "Qwen/Qwen-UI-Agent-4B",
    "Qwen/Qwen-UI-Agent-27B",
    "Tongyi-MAI/MAI-UI-2B",
    "Tongyi-MAI/MAI-UI-8B",
]


def main() -> None:
    for mid in CANDIDATES:
        try:
            info = model_info(mid, files_metadata=True)
            files = info.siblings or []
            total = sum((s.size or 0) for s in files)
            print(f"OK {mid} files={len(files)} bytes={total / 1e9:.2f}GB")
            for s in files[:15]:
                print(f"  {s.rfilename}\t{(s.size or 0) / 1e6:.1f}MB")
            if len(files) > 15:
                print(f"  ... +{len(files) - 15} more")
        except Exception as e:
            print(f"MISS {mid}: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
