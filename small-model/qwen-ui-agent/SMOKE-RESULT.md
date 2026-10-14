# MAI-UI-2B smoke evidence (CPU)

Date: 2026-09-26

## Result: PASS

- Checkpoint: `small-model/mai-ui-2b` (`model.safetensors` 4,255,140,280 bytes)
- Runtime: `.venv-mai-ui` — torch `2.14.0+cpu`, transformers `5.17.0`, CUDA unavailable
- Script: `scripts/check_mai_ui.py --device cpu --dtype float32 --max-new-tokens 48`
- Output text: `@` (matches synthetic red mail icon on demo UI)
- Timing: load ~17.1s, generate ~52.8s, total ~71.1s

Raw JSON: `scripts/_mai_ui_smoke.json`

## Not covered on this host

- Official `vllm==0.11.0` GPU serve (no NVIDIA)
- Full grounding agent loop against a real device/ADB
- Qwen-UI-Agent flagship weights (still not public)
