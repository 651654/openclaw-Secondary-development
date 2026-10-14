"""Download MAI-UI-2B (open predecessor of Qwen-UI-Agent) into small-model/mai-ui-2b."""
from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "mai-ui-2b"


def main() -> None:
    LOCAL.mkdir(parents=True, exist_ok=True)
    path = snapshot_download(
        repo_id="Tongyi-MAI/MAI-UI-2B",
        local_dir=str(LOCAL),
        max_workers=4,
    )
    print(f"DONE local_dir={path}")
    total = 0
    for p in LOCAL.rglob("*"):
        if p.is_file() and ".cache" not in p.parts:
            total += p.stat().st_size
            print(f"  {p.relative_to(LOCAL)}  {p.stat().st_size / 1e6:.1f}MB")
    print(f"TOTAL_VISIBLE_GB={total / 1e9:.2f}")


if __name__ == "__main__":
    main()
