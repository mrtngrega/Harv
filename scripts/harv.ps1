<#
  Start, stop or restart Harv (the server and the dashboard), safely.

    powershell -ExecutionPolicy Bypass -File scripts\harv.ps1 start     # or: stop, restart

  start    Opens the dashboard if Harv is already running; otherwise starts it
           hidden (no auto-restart, so Harv can edit its own code) and opens it.
  stop     Asks Harv to shut down cleanly (saves terminals, closes the database),
           then ends whatever is left on its ports. Never touches other programs.
  restart  stop, then start.

  The desktop shortcuts run this. Logs go to ~/.harv/logs/harv.log.
#>
param(
  [ValidateSet('start', 'stop', 'restart')]
  [string]$Action = 'start',
  # Seconds to wait first (the dashboard's Restart button uses this while the old Harv shuts down).
  [int]$Delay = 0,
  # Don't open the dashboard after starting.
  [switch]$NoBrowser,
  # Show a small "done" note (the desktop shortcuts run hidden, so there's no window to read).
  [switch]$Notify
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$HarvHome = if ($env:HARV_HOME) { $env:HARV_HOME } else { Join-Path $env:USERPROFILE '.harv' }
$Logs = Join-Path $HarvHome 'logs'
$PidFile = Join-Path $HarvHome 'harv.pid'
$Dashboard = 'http://127.0.0.1:5173'
$Server = 'http://127.0.0.1:4317'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Get-PortPids([int[]]$Ports) {
  $lines = netstat -ano | Select-String -Pattern 'LISTENING'
  $pids = foreach ($line in $lines) {
    $parts = ($line.ToString().Trim() -split '\s+')
    foreach ($port in $Ports) {
      if ($parts[1] -match ":$port$") { $parts[-1] }
    }
  }
  $pids | Where-Object { $_ -and $_ -ne '0' } | Sort-Object -Unique
}

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2 -Headers @{ Origin = $Dashboard } | Out-Null
    return $true
  } catch {
    return $false
  }
}

# taskkill through cmd: in Windows PowerShell its "not found" messages would otherwise stop the script.
function Stop-Tree([string]$Id) {
  cmd.exe /c "taskkill /PID $Id /T /F >nul 2>&1"
}

function Stop-Harv {
  # A clean shutdown first: Harv saves terminals and layout and closes its database.
  if (Get-PortPids 4317) {
    try {
      Invoke-WebRequest "$Server/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5 -Headers @{ Origin = $Dashboard } | Out-Null
    } catch {}
    for ($i = 0; $i -lt 24 -and (Get-PortPids 4317); $i++) { Start-Sleep -Milliseconds 250 }
  }
  # Then whatever is left: the process tree this script started, and anything still on Harv's ports.
  if (Test-Path $PidFile) {
    $old = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($old) { Stop-Tree $old }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  foreach ($p in (Get-PortPids 4317, 5173)) { Stop-Tree $p }
  for ($i = 0; $i -lt 20 -and (Get-PortPids 4317, 5173); $i++) { Start-Sleep -Milliseconds 250 }
}

function Start-Harv {
  $serverUp = Test-Url "$Server/api/health"
  $webUp = Test-Url $Dashboard
  if ($serverUp -and $webUp) {
    if (-not $NoBrowser) { Start-Process $Dashboard }
    Write-Host 'Harv is already running.'
    return
  }
  # Half running (or a stuck old process on the ports): clear it first.
  if (Get-PortPids 4317, 5173) { Stop-Harv }

  $log = Join-Path $Logs 'harv.log'
  if (Test-Path $log) { Move-Item $log (Join-Path $Logs 'harv.previous.log') -Force }
  # Twice: a start that quits at once can be a passing hiccup (2026-10-31: npm briefly couldn't find
  # concurrently right after a restart, and Harv stayed down until started by hand).
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run harv >> `"$log`" 2>&1" -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $proc.Id
    for ($i = 0; $i -lt 180; $i++) {
      if ((Test-Url "$Server/api/health") -and (Test-Url $Dashboard)) {
        if (-not $NoBrowser) { Start-Process $Dashboard }
        Write-Host 'Harv is running.'
        return
      }
      if ($proc.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $proc.HasExited) { break }
    Write-Log "start attempt $attempt quit at once"
    if (Get-PortPids 4317, 5173) { Stop-Harv }
    Start-Sleep -Seconds 3
  }
  Write-Log "didn't start (see harv.log)"
  Write-Host "Harv didn't start. See $log"
  Show-Note "Harv didn't start. The log opens now." 48
  Start-Process notepad.exe $log
  exit 1
}

function Write-Log([string]$Text) {
  Add-Content -Path (Join-Path $Logs 'harv-script.log') -Value "$(Get-Date -Format 's') [$PID] $Text"
}

function Show-Note([string]$Text, [int]$Icon = 64) {
  if ($Notify) { (New-Object -ComObject WScript.Shell).Popup($Text, 3, 'Harv', $Icon) | Out-Null }
}

Write-Log "$Action (delay $Delay)"
trap { Write-Log "failed: $_"; break }
if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }
switch ($Action) {
  'start' { Start-Harv }
  'stop' { Stop-Harv; Write-Host 'Harv is stopped.'; Show-Note 'Harv is stopped.' }
  'restart' { Stop-Harv; Write-Log 'stopped, starting'; Start-Harv }
}
Write-Log "$Action done"
