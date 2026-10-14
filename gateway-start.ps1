# Start the standalone OpenClaw gateway (detached). Idempotent unless -Restart.
# Resolves repo + Node from this script's location so shortcuts keep working after moves.
# OpenClaw 2026.9.5 requires Node >= 24.16.0 (or >= 26.1.0).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$forceRestart = $args -contains '-Restart' -or $args -contains '--restart'

function Resolve-NodeExe {
  $candidates = @(
    'D:\node24\node-v24.19.0-win-x64\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )
  foreach ($p in $candidates) {
    if (-not ($p -and (Test-Path $p))) { continue }
    try {
      $ver = & $p -p "process.versions.node" 2>$null
      if ($ver -match '^(\d+)\.(\d+)') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        # engines.node: >=24.16.0 <25 || >=26.1.0
        $ok = ($major -eq 24 -and $minor -ge 16) -or ($major -eq 26 -and $minor -ge 1) -or ($major -gt 26)
        if ($ok) { return $p }
      }
    } catch {}
  }
  throw "Node >= 24.16 (or >= 26.1) not found. OpenClaw 2026.9.5 refuses older runtimes."
}

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

$node = Resolve-NodeExe
$nodeDir = Split-Path -Parent $node
$GatewayPort = Get-ConfiguredGatewayPort

if (-not $env:OPENCLAW_CONFIG_PATH) {
  $env:OPENCLAW_CONFIG_PATH = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
}
if (-not $env:OPENCLAW_STATE_DIR) {
  $env:OPENCLAW_STATE_DIR = Join-Path $env:USERPROFILE '.openclaw'
}
if (-not $env:OPENCLAW_HOME) { $env:OPENCLAW_HOME = $env:OPENCLAW_STATE_DIR }
if (-not $env:OPENCLAW_CONFIG_DIR) { $env:OPENCLAW_CONFIG_DIR = $env:OPENCLAW_STATE_DIR }
if (-not $env:OPENCLAW_WORKSPACE_DIR) {
  $env:OPENCLAW_WORKSPACE_DIR = Join-Path $env:OPENCLAW_STATE_DIR 'workspace'
}
$env:OPENCLAW_GATEWAY_PORT = "$GatewayPort"
if (-not $env:OPENCLAW_GATEWAY_BIND) { $env:OPENCLAW_GATEWAY_BIND = 'loopback' }
$env:PATH = "$nodeDir;$env:PATH"

# Prefer IPv4 for Node fetch/DNS. Local Google Generative Language AAAA:443 often
# times out while A records work; without ipv4first, catalog refresh can hang first.
if (-not $env:NODE_OPTIONS) {
  $env:NODE_OPTIONS = '--dns-result-order=ipv4first'
} elseif ($env:NODE_OPTIONS -notmatch 'dns-result-order') {
  $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --dns-result-order=ipv4first"
}

# Load operator secrets/env for Gateway + ACP child harnesses.
$openclawEnvFile = Join-Path $env:OPENCLAW_STATE_DIR '.env'
if (Test-Path $openclawEnvFile) {
  Get-Content $openclawEnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

# Align DSH ACP profile with OpenClaw defaults when unset.
if (-not $env:DSH_OPENCLAW_PROVIDER) { $env:DSH_OPENCLAW_PROVIDER = 'deepseek-official' }
if (-not $env:DSH_OPENCLAW_MODEL) { $env:DSH_OPENCLAW_MODEL = 'deepseek-v4-pro' }

$cli = Join-Path $Root 'openclaw.mjs'
if (-not (Test-Path $cli)) {
  throw "openclaw.mjs not found under $Root"
}

$existing = Get-NetTCPConnection -State Listen -LocalPort $GatewayPort -ErrorAction SilentlyContinue
if ($existing -and -not $forceRestart) {
  Set-Content -Path (Join-Path $Root '.gateway.pid') -Value $existing[0].OwningProcess
  Write-Output "gateway already listening on $GatewayPort (pid $($existing[0].OwningProcess)); not starting a second instance"
  exit 0
}
if ($existing -and $forceRestart) {
  foreach ($row in $existing) {
    Stop-Process -Id $row.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$outLog = Join-Path $Root '.gateway.out.log'
$errLog = Join-Path $Root '.gateway.err.log'
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $node `
  -ArgumentList @('openclaw.mjs', 'gateway') `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path (Join-Path $Root '.gateway.pid') -Value $p.Id
Write-Output "gateway started pid $($p.Id) port $GatewayPort root $Root"
