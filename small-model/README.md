# small-model local stack

Local weights and scripts for vision experiments: PlayJev-0.8B cascade plus MAI-UI-2B (open proxy for Qwen-UI-Agent).
Weights/venvs stay local via `small-model/.gitignore`; scripts/docs/harness source are tracked.

## Layout

| Path                                | Role                                                                |
| ----------------------------------- | ------------------------------------------------------------------- |
| `omnijev-0.8b/`                     | OmniJev / PlayJev-0.8B HF checkpoint (`model.safetensors` ≈ 2.2 GB) |
| `playjev/`                          | Upstream PlayJev runtime                                            |
| `qwen2.5-7b-instruct-q4_k_m-*.gguf` | Local Qwen2.5-7B Instruct Q4_K_M (split GGUF)                       |
| `mai-ui-2b/`                        | Tongyi-MAI/MAI-UI-2B Qwen3-VL GUI agent (weights gitignored)        |
| `mai-ui-harness/`                   | Vendored MAI-UI agent source / cookbooks                            |
| `qwen-ui-agent/`                    | Download status, `DEPLOY.md`, `SMOKE-RESULT.md`                     |
| `.venv-mai-ui/`                     | MAI-UI transformers venv (CPU smoke verified)                       |
| `.venv-omnijev/`                    | PlayJev inference venv                                              |
| `scripts/`                          | Smoke / serve / cascade bridges                                     |
| `docs/0.8b-7b-cascade.md`           | Cascade design notes                                                |

## Host status (this machine)

- No NVIDIA (`nvidia-smi` unavailable); torch builds are **CPU-only**.
- PlayJev and MAI-UI smokes use `--device cpu --dtype float32` (wiring proof, not real-time).
- Official MAI-UI path needs `vllm==0.11.0` + CUDA when a GPU is available.
- No `llama-server` / `ollama` detected yet for the 7B GGUF; bridge supports any OpenAI-compatible `/v1/chat/completions`.

## MAI-UI-2B quickstart (CPU smoke)

```powershell
.\small-model\scripts\setup_mai_ui_venv.ps1 -Torch cpu
.\small-model\.venv-mai-ui\Scripts\python.exe .\small-model\scripts\check_mai_ui.py --device cpu --dtype float32 --max-new-tokens 48
```

Evidence: `qwen-ui-agent/SMOKE-RESULT.md` (PASS, total ~71s on this host).

## 0.8B quickstart

```powershell
# 1) Smoke load + one synthetic decision (CPU verified: load ~7s, forward ~3s)
.\small-model\.venv-omnijev\Scripts\python.exe .\small-model\scripts\check_omnijev.py --device cpu --dtype float32

# 2) Serve OpenJev-shaped endpoint
.\small-model\scripts\serve_omnijev.ps1 -Device cpu -Dtype float32 -Port 18732

# 3) Cascade bridge (vision only / dry-run)
.\small-model\.venv-omnijev\Scripts\python.exe .\small-model\scripts\bridge_vision_decision.py --image .\path\to\shot.jpg --dry-run
```

Smoke check on this host returned a full option distribution (`ok total_s≈17`). Treat low `allowed_mass` on out-of-domain frames as a gate signal — see the cascade doc.

With CUDA available later:

```powershell
.\small-model\scripts\serve_omnijev.ps1 -Device cuda:0 -Dtype bfloat16
```

## 7B quickstart (once a GGUF server exists)

Point any OpenAI-compatible server at the split GGUF under this folder, then:

```powershell
.\small-model\.venv-omnijev\Scripts\python.exe .\small-model\scripts\bridge_vision_decision.py `
  --image .\path\to\shot.jpg `
  --vision-url http://127.0.0.1:18732 `
  --llm-url http://127.0.0.1:8080/v1 `
  --llm-model qwen2.5-7b-instruct
```

## Re-download weights

```powershell
hf download OmniJev/PlayJev-0.8B --exclude "data/*" --local-dir .\small-model\omnijev-0.8b
```

## Recommended cascade (executed)

```powershell
# End-to-end: PlayJev-0.8B -> envelope + hard gates -> Qwen2.5-7B GGUF (llama-cli)
.\small-model\.venv-omnijev\Scripts\python.exe .\small-model\scripts\run_cascade.py `
  --make-demo-image --device cpu --dtype float32 --n-threads 6 --n-ctx 2048
```

Evidence: `small-model/scripts/_cascade_run.json`  
Local snapshots (not in git history): `.git/cascade-snapshots/` (`pre-compile-*` / `post-compile-*`).

On this host the demo frame correctly hard-gated to `wait` because `allowed_mass≈0`, even when 7B suggested `type_input`.
