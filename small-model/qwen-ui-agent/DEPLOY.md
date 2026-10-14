# Qwen-UI-Agent / MAI-UI local deploy notes

## Weight availability (2026-09-26)

| Target                                 | Status                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Qwen-UI-Agent** (4B / 27B / 35B-A3B) | **Not public.** No HF/ModelScope checkpoint. GitHub `Tongyi-MAI/MAI-UI/Qwen-UI-Agent/` is report + assets only. |
| **MAI-UI-2B / MAI-UI-8B**              | Public Apache-2.0 predecessors (`Tongyi-MAI/MAI-UI-2B`, `Tongyi-MAI/MAI-UI-8B`). Local proxy: `../mai-ui-2b/`.  |
| Harness code                           | `../mai-ui-harness/MAI-UI/` (agent Python). Qwen-UI-Agent folder has **no** inference runtime yet.              |

Architecture of the open weights: `Qwen3VLForConditionalGeneration` (`qwen3_vl`), BF16, `transformers>=4.57.1`.

## What you need beyond the model files

Nothing named “Qwen-UI-Agent” is a single downloadable binary. Deploy is **inference server + agent loop + device executor**.

### 1. Inference runtime (must build / install; not just copy weights)

Official path (MAI-UI README):

```bash
pip install vllm==0.11.0   # pin; also transformers>=4.57.0
python -m vllm.entrypoints.openai.api_server \
  --model <path-or-id> \
  --served-model-name MAI-UI-2B \
  --host 0.0.0.0 --port 8000 \
  --tensor-parallel-size 1 \
  --trust-remote-code
```

| Piece                                   | Role                         | Compile / install notes                                                                                                                 |
| --------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **vLLM 0.11.0**                         | OpenAI-compatible VL serving | Needs **NVIDIA CUDA** wheels (or source build). Not usable on this host’s CPU-only torch. Often pulls CUDA ops / FlashAttention stacks. |
| **transformers ≥ 4.57**                 | Qwen3-VL loader              | Pip package; no C++ project of your own.                                                                                                |
| **PyTorch + CUDA**                      | Backend for vLLM / HF        | Install matching CUDA toolkit + GPU drivers; not optional for practical speed.                                                          |
| Optional: **FlashAttention / xFormers** | Faster attention             | Usually comes via vLLM CUDA wheels; source builds are heavy.                                                                            |

**CPU-only fallback (smoke only):** `transformers` + `torch` CPU load of `mai-ui-2b` — no vLLM, very slow, not a product path.

**Not required for MAI-UI-2B:** llama.cpp / GGUF compile. These weights are safetensors VL, not the GGUF text-7B already in `small-model/`.

### 2. Agent harness (Python; no native compile)

Already under `../mai-ui-harness/MAI-UI/`:

- `src/mai_grounding_agent.py` — locate UI element → normalized `[x,y]`
- `src/mai_naivigation_agent.py` — multi-step mobile navigation (`click` / `type` / `swipe` / `ask_user` / `mcp_call` …)
- `requirements.txt` — `openai`, `Pillow`, `numpy`, `Jinja2` (pip only)

Cookbooks: `cookbook/grounding.ipynb`, `run_agent.ipynb` (point `llm_base_url` at the vLLM server).

### 3. Device / OS executor (you must supply; not in the weight drop)

The model only **emits structured actions**. To actually “operate the screen” you still need one of:

| Target    | Typical stack                                            | Build notes                                                          |
| --------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| Android   | ADB + screenshot loop (AndroidWorld / MobileWorld style) | Install Android platform-tools; device/emulator; no model compile    |
| Desktop   | OSWorld / custom Win32 / UI Automation                   | OSWorld itself is a large env (VM + packages), separate from the VLM |
| Browser   | Playwright / WebArena harness                            | `playwright install` browsers                                        |
| MCP tools | External MCP servers the agent can `mcp_call`            | Per-tool install                                                     |

Without an executor, weights + vLLM only give you **chat completions that look like clicks**.

### 4. Host reality check (this machine)

- Torch under `.venv-omnijev` is **CPU-only** → official vLLM path blocked until CUDA GPU + matching torch/vLLM.
- Disk: D: has headroom for ~4 GB MAI-UI-2B; 8B is ~16 GB BF16.
- VRAM ballpark: 2B BF16 needs roughly mid-single-digit GB + KV; 8B needs more; flagship Qwen-UI-Agent sizes (when/if released) need multi-GPU or heavy quant.

## Minimal deploy checklist (this host)

1. ~~Finish `mai-ui-2b/model.safetensors`~~ — done (4,255,140,280 bytes).
2. Harness: `mai-ui-harness/` full tree restored (src, cookbook, evaluation).
3. CPU smoke path (no NVIDIA on this machine):

```powershell
.\small-model\scripts\setup_mai_ui_venv.ps1 -Torch cpu
.\small-model\.venv-mai-ui\Scripts\python.exe .\small-model\scripts\check_mai_ui.py --device cpu --dtype float32 --max-new-tokens 64
```

4. Optional local HTTP wrapper (not vLLM):

```powershell
.\small-model\.venv-mai-ui\Scripts\python.exe .\small-model\scripts\serve_mai_ui_transformers.py --port 18740
```

5. Official GPU path when CUDA exists: `vllm==0.11.0` per upstream README.

## Relation to existing omnijev cascade

|          | omnijev-0.8b                        | MAI-UI-2B (proxy for UI agent)              |
| -------- | ----------------------------------- | ------------------------------------------- |
| Contract | Letter options → softmax            | Free-form VL → coordinates / tool_call JSON |
| Serve    | `serve_omnijev.ps1` `/v1/systemone` | vLLM `/v1/chat/completions`                 |
| Role     | System One scorer                   | End-to-end GUI agent (still needs executor) |

Do not expect to drop MAI-UI into the PlayJev SystemOne socket without a new bridge.
