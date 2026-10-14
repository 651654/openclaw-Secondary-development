# OpenClaw Control UI — desktop/repo launcher
# Checks Gateway port health, starts Gateway if needed, discovers Control UI assets,
# and opens Edge/Chrome --app. Falls back to static UI only with the correct WS URL.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartScript = Join-Path $Root 'gateway-start.ps1'
$StopScript = Join-Path $Root 'gateway-stop.ps1'
$StaticServerJs = Join-Path $Root 'OpenClaw-Control-UI-static-server.mjs'
$DefaultGatewayPort = 18789
$StaticPort = 4173
$UserDataDir = Join-Path $env:LOCALAPPDATA 'OpenClawControlUI\ChromiumProfile'
$ConfigPath = if ($env:OPENCLAW_CONFIG_PATH) {
  $env:OPENCLAW_CONFIG_PATH
} else {
  Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
}

function Show-LauncherMessage([string]$Text, [string]$Title = 'OpenClaw Control UI', [string]$Icon = 'Exclamation') {
  if ($env:OPENCLAW_LAUNCHER_SILENT -eq '1') { return }
  try {
    $w = New-Object -ComObject WScript.Shell
    # Auto-dismiss after 12s so silent shortcuts never hang forever.
    $null = $w.Popup($Text, 12, $Title, @{
        Information = 64
        Exclamation = 48
        Critical    = 16
      }[$Icon])
  } catch {
    # Headless / no UI host — ignore.
  }
}

function Test-PortListening([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-JsonObject([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try {
    return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Get-ConfiguredGatewayPort {
  $j = Get-JsonObject $ConfigPath
  $p = $j.gateway.port
  if ($p -is [int] -and $p -gt 0 -and $p -lt 65536) { return $p }
  if ($p -is [string] -and $p -match '^\d+$') {
    $n = [int]$p
    if ($n -gt 0 -and $n -lt 65536) { return $n }
  }
  if ($env:OPENCLAW_GATEWAY_PORT -match '^\d+$') {
    $n = [int]$env:OPENCLAW_GATEWAY_PORT
    if ($n -gt 0 -and $n -lt 65536) { return $n }
  }
  return $DefaultGatewayPort
}

function Get-GatewayToken {
  if ($env:OPENCLAW_GATEWAY_TOKEN -and $env:OPENCLAW_GATEWAY_TOKEN.Trim().Length -gt 0) {
    return $env:OPENCLAW_GATEWAY_TOKEN.Trim()
  }
  $j = Get-JsonObject $ConfigPath
  $t = $j.gateway.auth.token
  if ($t -is [string] -and $t.Trim().Length -gt 0) { return $t.Trim() }
  return $null
}

function Resolve-NodeExe {
  $candidates = @(
    'D:\node24\node-v24.19.0-win-x64\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Resolve-ControlUiIndex {
  $candidates = @(
    (Join-Path $Root 'dist\control-ui\index.html'),
    (Join-Path $Root 'apps\control-ui\dist\index.html'),
    (Join-Path $Root 'ui\dist\index.html'),
    (Join-Path $Root 'dist\ui\index.html')
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return (Resolve-Path $p).Path }
  }

  # Bounded search: prefer newest control-ui index under the repo (skip huge trees).
  $skip = @('node_modules', '.git', 'coverage', 'tmp', '.tmp', 'vendor')
  try {
    $hits = Get-ChildItem -Path $Root -Filter 'index.html' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $full = $_.FullName
        $parts = $full.Substring($Root.Length).Split([IO.Path]::DirectorySeparatorChar)
        ($parts -contains 'control-ui') -and -not ($parts | Where-Object { $skip -contains $_ })
      } |
      Sort-Object LastWriteTime -Descending
    if ($hits -and $hits.Count -gt 0) {
      return $hits[0].FullName
    }
  } catch {}
  return $null
}

function Test-GatewayHealthy([int]$Port) {
  if (-not (Test-PortListening $Port)) { return $false }
  $sawAuthChallenge = $false
  foreach ($path in @('/healthz', '/readyz', '/health', '/')) {
    try {
      $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port$path")
      $req.Method = 'GET'
      $req.Timeout = 2500
      $req.ReadWriteTimeout = 2500
      $req.KeepAlive = $false
      $resp = $req.GetResponse()
      $code = [int]$resp.StatusCode
      $resp.Close()
      if ($code -ge 200 -and $code -lt 500) { return $true }
    } catch {
      # Auth-gated roots may 401; connection refused / reset means unhealthy.
      # Read/connect timeouts with zero response bytes mean the port is listening
      # but the event loop is starved — do NOT treat that as healthy (white screen).
      $msg = $_.Exception.Message
      if ($msg -match '401|403|Unauthorized') {
        $sawAuthChallenge = $true
        continue
      }
      if ($msg -match 'timed out|Timeout|Unable to connect|actively refused|connection was closed|forcibly closed') {
        return $false
      }
    }
  }
  # Auth challenge without a body still proves the HTTP stack answered.
  if ($sawAuthChallenge) { return $true }
  return $false
}

function Get-GatewayLogTail([int]$Lines = 12) {
  $chunks = @()
  foreach ($name in @('.gateway.err.log', '.gateway.out.log')) {
    $path = Join-Path $Root $name
    if (Test-Path $path) {
      try {
        $tail = Get-Content $path -Tail $Lines -ErrorAction SilentlyContinue
        if ($tail) { $chunks += "--- $name ---"; $chunks += $tail }
      } catch {}
    }
  }
  return ($chunks -join "`n")
}

function Repair-BlockingConfigFromLog([string]$LogText) {
  # Desktop launchers must not hang on interactive doctor. Apply the known
  # shipped migration: strip legacy plugins.installs (plugin-install-config-migration).
  if ($LogText -notmatch 'installs') { return $false }
  if ($LogText -notmatch 'Invalid config|Unrecognized key') { return $false }
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }

  $node = Resolve-NodeExe
  if (-not $node) { return $false }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = "$ConfigPath.launcher-bak-$stamp"
  $repairLog = Join-Path $Root '.gateway.repair.log'
  try {
    Copy-Item -LiteralPath $ConfigPath -Destination $bak -Force
  } catch {
    Set-Content -LiteralPath $repairLog -Value ("backup_failed: " + $_.Exception.Message) -Encoding utf8
    return $false
  }

  $js = @(
    "import fs from 'node:fs';"
    "const path = process.argv[2];"
    "const raw = fs.readFileSync(path, 'utf8');"
    "const cfg = JSON.parse(raw);"
    "if (!cfg || typeof cfg !== 'object' || !cfg.plugins || typeof cfg.plugins !== 'object') process.exit(2);"
    "if (!Object.prototype.hasOwnProperty.call(cfg.plugins, 'installs')) process.exit(3);"
    "delete cfg.plugins.installs;"
    "if (Object.keys(cfg.plugins).length === 0) delete cfg.plugins;"
    "fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');"
    "process.exit(0);"
  ) -join "`n"

  $tmpJs = Join-Path $env:TEMP ("openclaw-strip-installs-" + [guid]::NewGuid().ToString('N') + ".mjs")
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($tmpJs, $js, $utf8NoBom)
    $p = Start-Process -FilePath $node `
      -ArgumentList @($tmpJs, $ConfigPath) `
      -WindowStyle Hidden -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $Root '.gateway.repair.out.log') `
      -RedirectStandardError (Join-Path $Root '.gateway.repair.err.log')
    $msg = "strip_exit=$($p.ExitCode) bak=$bak config=$ConfigPath"
    Set-Content -LiteralPath $repairLog -Value $msg -Encoding utf8
    return ($p.ExitCode -eq 0)
  } catch {
    Set-Content -LiteralPath $repairLog -Value ("strip_exception: " + $_.Exception.Message) -Encoding utf8
    return $false
  } finally {
    Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
  }
}

function Start-GatewayProcess {
  if (-not (Test-Path $StartScript)) { return $false }
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $StartScript) `
    -WindowStyle Hidden | Out-Null
  return $true
}

function Wait-GatewayHealthy([int]$Port, [int]$TimeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-GatewayHealthy $Port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (Test-GatewayHealthy $Port)
}

function Ensure-GatewayRunning([int]$Port) {
  if (Test-GatewayHealthy $Port) { return $true }

  if (-not (Start-GatewayProcess)) { return $false }
  # Fail fast on known config crashes so doctor can run without a full timeout.
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if (Test-GatewayHealthy $Port) { return $true }
    $earlyLog = Get-GatewayLogTail 30
    if ($earlyLog -match 'Invalid config|Unrecognized key|doctor --fix') { break }
    Start-Sleep -Milliseconds 400
  }
  if (Test-GatewayHealthy $Port) { return $true }

  # Config / boot crashes: strip known blocking legacy keys, then restart.
  $log = Get-GatewayLogTail 30
  if ($log -match 'doctor --fix|Invalid config|Unrecognized key') {
    $null = Repair-BlockingConfigFromLog $log
    # Do not call interactive/slow doctor from the desktop shortcut path.
    if (Test-Path $StopScript) {
      Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $StopScript) `
        -WindowStyle Hidden -Wait | Out-Null
    }
    Start-Sleep -Seconds 1
    $null = Start-GatewayProcess
    if (Wait-GatewayHealthy $Port 45) { return $true }
  } else {
    if (Wait-GatewayHealthy $Port 25) { return $true }
  }

  return (Test-GatewayHealthy $Port)
}

function Resolve-AppBrowser {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Open-ControlUiApp([string]$Url) {
  $browser = Resolve-AppBrowser
  if (-not $browser) {
    Start-Process $Url
    return
  }
  if (-not (Test-Path $UserDataDir)) {
    New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
  }
  $args = @(
    "--app=$Url",
    "--user-data-dir=$UserDataDir",
    '--no-first-run',
    '--disable-features=TranslateUI',
    '--new-window'
  )
  Start-Process -FilePath $browser -ArgumentList $args | Out-Null
}

function Ensure-StaticControlUi([string]$UiDistDir, [int]$Port) {
  $node = Resolve-NodeExe
  if (-not $node -or -not (Test-Path $StaticServerJs) -or -not (Test-Path (Join-Path $UiDistDir 'index.html'))) {
    return $false
  }
  if (-not (Test-PortListening $Port)) {
    Start-Process -FilePath $node `
      -ArgumentList @($StaticServerJs, $UiDistDir, "$Port") `
      -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(8)
    while (-not (Test-PortListening $Port)) {
      if ((Get-Date) -gt $deadline) { return $false }
      Start-Sleep -Milliseconds 250
    }
  }
  return (Test-PortListening $Port)
}

# --- main ---
$GatewayPort = Get-ConfiguredGatewayPort
$indexHtml = Resolve-ControlUiIndex
$uiDist = if ($indexHtml) { Split-Path -Parent $indexHtml } else { $null }

$gatewayOk = Ensure-GatewayRunning $GatewayPort

if ($gatewayOk) {
  $token = Get-GatewayToken
  $url = "http://127.0.0.1:$GatewayPort/"
  if ($token) { $url = "$url#token=$([uri]::EscapeDataString($token))" }
  Open-ControlUiApp $url
  exit 0
}

# Gateway still down: last-resort static shell, but wire the correct Gateway WS target.
$logTail = Get-GatewayLogTail 16
if ($uiDist -and (Ensure-StaticControlUi $uiDist $StaticPort)) {
  $ws = "ws://127.0.0.1:$GatewayPort"
  $token = Get-GatewayToken
  $q = "gatewayUrl=$([uri]::EscapeDataString($ws))"
  $url = "http://127.0.0.1:$StaticPort/?$q"
  if ($token) { $url = "$url#token=$([uri]::EscapeDataString($token))" }
  Open-ControlUiApp $url
  $hint = @(
    "Gateway is not ready on port $GatewayPort.",
    "Opened static Control UI with WebSocket preset:",
    $ws,
    "",
    "Try: openclaw doctor --fix",
    "Then: openclaw gateway run",
    "",
    $logTail
  ) -join "`n"
  Show-LauncherMessage $hint "OpenClaw: Gateway not ready" "Exclamation"
  exit 0
}

$fail = @(
  "Could not start OpenClaw Gateway on port $GatewayPort,",
  "and no usable Control UI assets were found.",
  "",
  "Check:",
  "1. Repo has openclaw.mjs and gateway-start.ps1",
  "2. Built UI exists at dist\control-ui\index.html",
  "3. Run: openclaw doctor --fix",
  "4. Run: openclaw gateway run",
  "",
  $logTail
) -join "`n"
Show-LauncherMessage $fail "OpenClaw Control UI failed" "Critical"
exit 1
