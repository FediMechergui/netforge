<#
.SYNOPSIS
  Power and load preflight before a slow-project, gate-project or full-check run (ARCHITECTURE-P3C section 0, rule 24).

.DESCRIPTION
  Prints (Get-CimInstance Win32_Battery).BatteryStatus for every battery and succeeds only when EVERY battery reports
  2, 3, 6, 7, 8 or 9 (unknown/AC, fully charged, charging, charging-high, charging-low, charging-critical), or when the
  query returns no battery (a desktop is on AC). Any other value (1 discharging, 4 low, 5 critical, 10 undefined,
  11 partially charged) refuses. It also refuses while another vitest process runs (rule 24: no other project's vitest
  at the same time), unless -SkipLoadCheck is given.

  Exit code 0 = go; 1 = refused. Usage, from the repository root:
    powershell -NoProfile -File scripts/preflight-ac.ps1 ; if ($LASTEXITCODE -eq 0) { npx vitest run --root packages/engine --project slow }

.PARAMETER SkipLoadCheck
  Do not look for other vitest processes (power is still checked).
#>
param(
  [switch]$SkipLoadCheck
)

$ErrorActionPreference = 'Stop'

# Rule 24: the statuses that mean the machine is on mains power.
$onAc = @(2, 3, 6, 7, 8, 9)
$names = @{
  1 = 'discharging'; 2 = 'unknown (AC)'; 3 = 'fully charged'; 4 = 'low'; 5 = 'critical'; 6 = 'charging';
  7 = 'charging and high'; 8 = 'charging and low'; 9 = 'charging and critical'; 10 = 'undefined'; 11 = 'partially charged'
}

$refused = $false
$batteries = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)
if ($batteries.Count -eq 0) {
  Write-Output 'power: no battery (a desktop on AC): go'
} else {
  $i = 0
  foreach ($b in $batteries) {
    $i++
    $status = [int]$b.BatteryStatus
    $label = $names[$status]
    if ($null -eq $label) { $label = 'unknown value' }
    $charge = $b.EstimatedChargeRemaining
    if ($onAc -contains $status) {
      Write-Output ("power: battery {0}: BatteryStatus {1} ({2}), charge {3}%: go" -f $i, $status, $label, $charge)
    } else {
      Write-Output ("power: battery {0}: BatteryStatus {1} ({2}), charge {3}%: REFUSED (not on AC)" -f $i, $status, $label, $charge)
      $refused = $true
    }
  }
}

if (-not $SkipLoadCheck) {
  $others = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'vitest' })
  if ($others.Count -gt 0) {
    foreach ($p in $others) { Write-Output ("load: vitest already running (pid {0}): REFUSED" -f $p.ProcessId) }
    $refused = $true
  } else {
    Write-Output 'load: no other vitest process: go'
  }
}

if ($refused) {
  Write-Output 'preflight: REFUSED'
  exit 1
}
Write-Output 'preflight: go'
exit 0
