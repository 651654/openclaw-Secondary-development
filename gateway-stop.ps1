# Stop the standalone OpenClaw gateway (and its child tree) started via gateway-start.ps1
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $Root '.gateway.pid'

function Get-ConfiguredGatewayPort {
  $configPath = if ($env:OPENCLAW_CONFIG_PATH) {
    $env:OPENCLAW_CONFIG_PATH
  } else {
    Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
  }
  if (Test-Path $configPath) {
    try {
      $j = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $p = $j.gateway.port
      if ($p -is [int] -and $p -gt 0) { return $p }
      if ($p -is [string] -and $p -match '^\d+$') { return [int]$p }
    } catch {}
  }
  if ($env:OPENCLAW_GATEWAY_PORT -match '^\d+$') { return [int]$env:OPENCLAW_GATEWAY_PORT }
  return 18789
}

if (Test-Path $pidFile) {
  $gpid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if ($gpid -match '^\d+$') {
    $proc = Get-Process -Id $gpid -ErrorAction SilentlyContinue
    if ($proc) {
      & taskkill /PID $gpid /T /F 2>$null | Out-Null
      Write-Output "gateway tree $gpid stopped"
    } else {
      Write-Output "pid $gpid not running"
    }
  }
} else {
  Write-Output "no pid file at $pidFile"
}

# Also stop any other node running openclaw.mjs gateway on this checkout / port.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'openclaw\.mjs gateway' } |
  ForEach-Object {
    & taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null
    Write-Output "stray gateway pid $($_.ProcessId) stopped"
  }

$GatewayPort = Get-ConfiguredGatewayPort
$listeners = Get-NetTCPConnection -State Listen -LocalPort $GatewayPort -ErrorAction SilentlyContinue
foreach ($row in $listeners) {
  Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Output "stopped listener pid $($row.OwningProcess) on $GatewayPort"
}

Write-Output "stop-done"
