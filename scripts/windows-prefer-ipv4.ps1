#Requires -RunAsAdministrator
# Prefer IPv4 over IPv6 on Windows (DisabledComponents = 0x20).
# Use when AAAA:443 to Google APIs times out while A:443 works.
# Reboot required for the preference to apply system-wide.
$ErrorActionPreference = 'Stop'
$path = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters'
if (-not (Test-Path $path)) {
  New-Item -Path $path -Force | Out-Null
}
New-ItemProperty -Path $path -Name DisabledComponents -PropertyType DWord -Value 0x20 -Force | Out-Null
$v = (Get-ItemProperty $path).DisabledComponents
Write-Output "DisabledComponents=$v (Prefer IPv4). Reboot Windows for full effect."
