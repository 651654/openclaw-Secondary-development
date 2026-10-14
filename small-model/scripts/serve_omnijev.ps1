# Start local OmniJev/PlayJev-0.8B OpenJev-compatible server.
# Endpoint: http://127.0.0.1:18732/v1/systemone
#
# Usage:
#   .\small-model\scripts\serve_omnijev.ps1
#   .\small-model\scripts\serve_omnijev.ps1 -Device cuda:0 -Dtype bfloat16
#   .\small-model\scripts\serve_omnijev.ps1 -Port 18732 -Device cpu -Dtype float32

param(
  [string]$Device = "cpu",
  [string]$Dtype = "float32",
  [int]$Port = 18732,
  [string]$HostAddr = "127.0.0.1",
  [string]$Ckpt = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Ckpt) { $Ckpt = Join-Path $Root "omnijev-0.8b" }
$VenvPython = Join-Path $Root ".venv-omnijev\Scripts\python.exe"
$ServePy = Join-Path $PSScriptRoot "serve_omnijev.py"

if (-not (Test-Path $VenvPython)) {
  throw "Missing venv at $VenvPython. Create it first (see small-model/README.md)."
}
if (-not (Test-Path (Join-Path $Ckpt "model.safetensors"))) {
  throw "Missing checkpoint: $Ckpt\model.safetensors"
}

Write-Host "Serving PlayJev from $Ckpt on http://${HostAddr}:${Port}/v1/systemone"
Write-Host "device=$Device dtype=$Dtype"
& $VenvPython $ServePy --ckpt $Ckpt --host $HostAddr --port $Port --device $Device --dtype $Dtype
