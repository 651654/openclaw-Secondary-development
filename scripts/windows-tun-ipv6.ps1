# Diagnose / enable proxy TUN IPv6 hijack for Google Generative Language AAAA timeouts.
# Does not print secrets. Safe to run without admin for diagnosis; config edits need writable profiles.
$ErrorActionPreference = 'Continue'

Write-Output '=== adapters (TUN/TAP/Wintun) ==='
Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceDescription -match 'TAP|Wintun|Meta|Clash|sing|WireGuard|TUN' -or $_.Name -match 'Meta|Clash|sing|wintun' } |
  Format-Table Name, InterfaceDescription, Status, MacAddress -AutoSize

Write-Output '=== default IPv6 route (::/0) ==='
Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue |
  Format-Table DestinationPrefix, NextHop, InterfaceAlias, RouteMetric -AutoSize

Write-Output '=== probe generativelanguage IPv4/IPv6 TCP 443 ==='
$node = @(
  'D:\node24\node-v24.19.0-win-x64\node.exe',
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($node) {
  & $node --input-type=module -e @"
import dns from 'node:dns/promises';
import net from 'node:net';
const host = 'generativelanguage.googleapis.com';
const v4 = await dns.resolve4(host);
const v6 = await dns.resolve6(host);
async function tcp(ip, family) {
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const s = net.createConnection({ host: ip, port: 443, family }, () => {
      s.destroy();
      resolve({ ip, family, ok: true, ms: Date.now() - t0 });
    });
    s.setTimeout(5000);
    s.on('timeout', () => { s.destroy(); resolve({ ip, family, ok: false, error: 'timeout', ms: Date.now() - t0 }); });
    s.on('error', (e) => resolve({ ip, family, ok: false, error: e.code || e.message, ms: Date.now() - t0 }));
  });
}
console.log(JSON.stringify({ tcp4: await tcp(v4[0], 4), tcp6: await tcp(v6[0], 6) }, null, 2));
"@
}

$candidates = @(
  (Join-Path $env:USERPROFILE 'AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev'),
  (Join-Path $env:USERPROFILE 'AppData\Roaming\clash-verge'),
  (Join-Path $env:USERPROFILE 'AppData\Roaming\Clash for Windows'),
  (Join-Path $env:USERPROFILE '.config\clash-verge'),
  (Join-Path $env:USERPROFILE '.config\mihomo'),
  (Join-Path $env:USERPROFILE '.config\clash')
) | Where-Object { Test-Path $_ }

Write-Output '=== proxy profile roots found ==='
if (-not $candidates) {
  Write-Output 'None. Install Clash Verge / Mihomo / similar, enable TUN, then enable IPv6 in TUN settings.'
  Write-Output 'Required outcome: ::/0 next hop should be the TUN adapter, not the ISP ethernet gateway.'
  exit 0
}
$candidates | ForEach-Object { Write-Output $_ }

# Best-effort: rewrite common Clash Meta tun.ipv6 / tun.enable keys when profiles exist.
$edited = 0
foreach ($root in $candidates) {
  Get-ChildItem $root -Recurse -Include '*.yaml','*.yml' -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -lt 2MB } |
    ForEach-Object {
      $raw = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
      if (-not $raw) { return }
      if ($raw -notmatch '(?m)^\s*tun\s*:') { return }
      $next = $raw
      if ($next -match '(?m)^\s*enable\s*:\s*false') {
        $next = [regex]::Replace($next, '(?m)^(\s*enable\s*:\s*)false', '${1}true')
      }
      if ($next -match '(?m)^\s*ipv6\s*:\s*false') {
        $next = [regex]::Replace($next, '(?m)^(\s*ipv6\s*:\s*)false', '${1}true')
      } elseif ($next -match '(?m)^\s*tun\s*:' -and $next -notmatch '(?m)^\s*ipv6\s*:') {
        $next = [regex]::Replace($next, '(?m)^(\s*tun\s*:\s*\r?\n)', "`$1  ipv6: true`r`n")
      }
      if ($next -ne $raw) {
        Copy-Item $_.FullName "$($_.FullName).bak-before-ipv6" -Force
        Set-Content -Path $_.FullName -Value $next -Encoding UTF8
        Write-Output "updated $($_.FullName)"
        $edited++
      }
    }
}
Write-Output "profiles-updated=$edited"
Write-Output 'Restart the proxy app, confirm TUN is on, then re-check ::/0 and tcp6 above.'
