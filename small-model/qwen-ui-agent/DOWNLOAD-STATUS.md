# Qwen-UI-Agent download status

Updated: 2026-09-26 (post CPU smoke)

## Result: Qwen-UI-Agent WEIGHTS NOT PUBLIC

Probed Hugging Face (all missing):

- Tongyi-MAI/Qwen-UI-Agent{,-4B,-27B,-35B-A3B}
- Qwen/Qwen-UI-Agent{,-4B,-27B}

GitHub `Tongyi-MAI/MAI-UI/Qwen-UI-Agent/` = technical report + assets only (no checkpoint, no serve code).

## Proxy downloaded (complete)

| Asset                 | Path                 | Status                                                 |
| --------------------- | -------------------- | ------------------------------------------------------ |
| **MAI-UI-2B** weights | `../mai-ui-2b/`      | **OK** — `model.safetensors` = **4,255,140,280** bytes |
| Tokenizer / config    | same dir             | OK                                                     |
| MAI-UI harness        | `../mai-ui-harness/` | OK (src/cookbook/eval scripts vendored)                |
| Deploy notes          | `./DEPLOY.md`        | Install paths beyond weights                           |
| CPU smoke             | `./SMOKE-RESULT.md`  | **PASS** — load+generate on demo UI, text=`@`          |

Architecture: `Qwen3VLForConditionalGeneration` (`qwen3_vl`), BF16, needs `transformers>=4.57`.

## Resume (if needed later)

```powershell
curl.exe -L --retry 20 --retry-delay 5 --retry-all-errors -C - --fail `
  -o .\small-model\mai-ui-2b\model.safetensors `
  https://hf-mirror.com/Tongyi-MAI/MAI-UI-2B/resolve/main/model.safetensors
```
