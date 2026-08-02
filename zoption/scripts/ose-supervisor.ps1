# Keep the Option Selling Engine running.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ose-supervisor.ps1          one check
#   powershell -ExecutionPolicy Bypass -File scripts\ose-supervisor.ps1 -Loop    stay resident
#
# Idempotent and cheap: it checks whether the engine is already up and starts it
# only if it is not. Safe to run while the engine is running — it does nothing.
#
# ---------------------------------------------------------------------------
# What this does NOT do
# ---------------------------------------------------------------------------
#
# It does not make the engine trade. The engine still needs:
#
#   * a Kotak session, which requires an interactive TOTP + MPIN login and
#     cannot be automated (`[MUST-CONFIRM #14]`)
#   * `ose_intent` = RUN — the Stop button still stops it
#   * no kill-switch file, and no HALT from the risk engine
#
# So this keeps the PROCESS up. Whether it trades is still entirely under the
# controls that were already there.
#
# ---------------------------------------------------------------------------
# Why it never force-starts
# ---------------------------------------------------------------------------
#
# Two engines on one account would double every order. The engine takes a
# database leader lock and refuses to start when another holds it, and this
# leans on that rather than second-guessing it: a start that exits because the
# lock is held is the correct outcome, not an error to retry harder. The lock's
# 30-second TTL means a force-killed engine's slot frees itself, so the next
# pass picks it up on its own.

param([switch]$Loop, [int]$IntervalSeconds = 60)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $root 'logs\ose-supervisor.log'

function Write-Line([string]$message) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Write-Output "$stamp  $message"
  try { Add-Content -Path $log -Value "$stamp  $message" -Encoding utf8 } catch {}
}

function Get-Engine {
  # Matched on the SCRIPT PATH, not on "node.exe", so the web app and any other
  # Node process on this box are left alone.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*oseEngine.js*' }
}

function Invoke-Check {
  $running = Get-Engine
  if ($running) { return $true }

  Write-Line "engine is not running - starting it"
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'ose' -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 20

  $now = Get-Engine
  if ($now) {
    Write-Line "started (PID $($now.ProcessId -join ', '))"
    return $true
  }
  Write-Line "did NOT come up - see logs\error.log (a held leader lock clears within 30s, and the next pass will retry)"
  return $false
}

if (-not $Loop) {
  $ok = Invoke-Check
  if ($ok) { Write-Line "ok" }
  exit 0
}

Write-Line "supervisor resident, checking every ${IntervalSeconds}s (Ctrl-C to stop)"
while ($true) {
  try { Invoke-Check | Out-Null } catch { Write-Line "check failed: $($_.Exception.Message)" }
  Start-Sleep -Seconds $IntervalSeconds
}
