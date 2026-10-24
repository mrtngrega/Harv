<#
  Puts three shortcuts on the desktop: Harv (start and open), Restart Harv, Stop Harv.
  Run again any time to recreate them:
    powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
  Nothing starts with Windows; that's decided with the desktop app (M9).
#>
$ErrorActionPreference = 'Stop'
$Script = Join-Path $PSScriptRoot 'harv.ps1'
$Icons = Join-Path $PSScriptRoot 'icons'
$Desktop = [Environment]::GetFolderPath('Desktop')
$Shell = New-Object -ComObject WScript.Shell

foreach ($s in @(
    @{ Name = 'Harv'; Action = 'start'; Icon = 'harv-start.ico'; Tip = 'Start Harv and open the dashboard' },
    @{ Name = 'Restart Harv'; Action = 'restart'; Icon = 'harv-restart.ico'; Tip = 'Restart Harv (loads changes to its own code)' },
    @{ Name = 'Stop Harv'; Action = 'stop'; Icon = 'harv-stop.ico'; Tip = 'Stop Harv safely' }
  )) {
  $link = $Shell.CreateShortcut((Join-Path $Desktop "$($s.Name).lnk"))
  $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`" $($s.Action) -Notify"
  $link.WorkingDirectory = Split-Path -Parent $PSScriptRoot
  $link.IconLocation = Join-Path $Icons $s.Icon
  $link.Description = $s.Tip
  $link.WindowStyle = 7
  $link.Save()
  Write-Host "Created $($s.Name) on the desktop."
}
