"""Minimal local HTTP smoke wrapper for MAI-UI-2B via transformers (CPU/CUDA).

Not a substitute for official vLLM. Exposes POST /v1/chat/completions with a
single image_url (data URL or file path) + text for wiring tests.

  .\\.venv-mai-ui\\Scripts\\python.exe .\\scripts\\serve_mai_ui_transformers.py --port 18740
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CKPT_DEFAULT = ROOT / "mai-ui-2b"

_MODEL = None
_PROCESSOR = None
_DEVICE = "cpu"


def _load(ckpt: Path, device: str, dtype_name: str) -> None:
    global _MODEL, _PROCESSOR, _DEVICE
    import torch
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

    dtype = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }[dtype_name]
    _DEVICE = device if device != "auto" else ("cuda:0" if torch.cuda.is_available() else "cpu")
    _PROCESSOR = AutoProcessor.from_pretrained(str(ckpt), trust_remote_code=True)
    _MODEL = Qwen3VLForConditionalGeneration.from_pretrained(
        str(ckpt), torch_dtype=dtype, trust_remote_code=True
    )
    _MODEL.to(_DEVICE)
    _MODEL.eval()


def _image_from_url(url: str) -> Image.Image:
    if url.startswith("data:"):
        m = re.match(r"data:image/[^;]+;base64,(.+)", url, re.DOTALL)
        if not m:
            raise ValueError("unsupported data URL")
        raw = base64.b64decode(m.group(1))
        return Image.open(io.BytesIO(raw)).convert("RGB")
    parsed = urlparse(url)
    if parsed.scheme in ("", "file"):
        path = Path(parsed.path if parsed.scheme == "file" else url)
        return Image.open(path).convert("RGB")
    raise ValueError(f"unsupported image_url scheme: {parsed.scheme}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/health", "/v1/models"):
            self._json(200, {"ok": True, "model": "MAI-UI-2B", "device": _DEVICE})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        import torch

        if self.path not in ("/v1/chat/completions", "/chat/completions"):
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        messages = payload.get("messages") or []
        max_new = int(payload.get("max_tokens") or payload.get("max_new_tokens") or 64)

        text_parts: list[str] = []
        image: Image.Image | None = None
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, str):
                text_parts.append(content)
                continue
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text":
                        text_parts.append(str(part.get("text") or ""))
                    elif part.get("type") in ("image_url", "image"):
                        url = part.get("image_url")
                        if isinstance(url, dict):
                            url = url.get("url")
                        if not url and part.get("image"):
                            url = part["image"]
                        image = _image_from_url(str(url))
        if image is None:
            self._json(400, {"error": "image required"})
            return
        prompt = "\n".join(t for t in text_parts if t).strip() or "Describe the UI."

        chat = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        prompt_text = _PROCESSOR.apply_chat_template(
            chat, tokenize=False, add_generation_prompt=True
        )
        inputs = _PROCESSOR(
            text=[prompt_text], images=[image], return_tensors="pt", padding=True
        )
        inputs = {k: (v.to(_DEVICE) if hasattr(v, "to") else v) for k, v in inputs.items()}
        with torch.inference_mode():
            out = _MODEL.generate(**inputs, max_new_tokens=max_new, do_sample=False)
        prompt_len = inputs["input_ids"].shape[-1]
        text = _PROCESSOR.batch_decode(out[:, prompt_len:], skip_special_tokens=True)[0].strip()
        self._json(
            200,
            {
                "id": "mai-ui-local",
                "object": "chat.completion",
                "model": "MAI-UI-2B",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
            },
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, default=CKPT_DEFAULT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18740)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default="float32", choices=("float32", "float16", "bfloat16"))
    args = ap.parse_args()
    print(f"loading {args.ckpt} device={args.device} dtype={args.dtype}")
    _load(args.ckpt, args.device, args.dtype)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"serving http://{args.host}:{args.port}/v1/chat/completions")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
