# Create / refresh the MAI-UI Python venv and install CPU (or CUDA) inference deps.
# Official production path uses vLLM+CUDA; this host may only support transformers CPU smoke.

param(
  [string]$Python = "python",
  [ValidateSet("cpu", "cuda")]
  [string]$Torch = "cpu",
  [switch]$SkipVenvCreate
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root ".venv-mai-ui"
$Py = Join-Path $Venv "Scripts\python.exe"
$Pip = Join-Path $Venv "Scripts\pip.exe"

Write-Host "Root=$Root"
Write-Host "Torch=$Torch"

if (-not $SkipVenvCreate) {
  if (-not (Test-Path $Py)) {
    & $Python -m venv $Venv
  }
}

& $Py -m pip install --upgrade pip setuptools wheel

if ($Torch -eq "cpu") {
  & $Pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
} else {
  & $Pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
}

# Qwen3-VL needs a recent transformers; pin a known-good floor from model card.
& $Pip install "transformers>=4.57.0" "accelerate>=1.0.0" "safetensors>=0.4.0" "Pillow>=10.0.0" "sentencepiece" "protobuf"

# Harness agent deps (OpenAI client for vLLM path; still useful for local scripting)
$Req = Join-Path $Root "mai-ui-harness\MAI-UI\requirements.txt"
if (Test-Path $Req) {
  & $Pip install -r $Req
}

Write-Host "==== versions ===="
& $Py -c "import torch, transformers; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('transformers', transformers.__version__)"
Write-Host "DONE venv=$Venv"
