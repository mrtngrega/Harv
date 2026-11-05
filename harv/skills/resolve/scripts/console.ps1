# Types one line into DaVinci Resolve's Console (Workspace > Console, F6) and presses Enter.
# Used by resolve.mjs to start Harv's bridge: free Resolve runs scripts only from there.
# The line comes base64 (UTF-8) so no shell or SendKeys quoting can change it.
param([Parameter(Mandatory = $true)][string]$LineB64)
$ErrorActionPreference = 'Stop'
$line = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LineB64))

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ResolveWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<KeyValuePair<IntPtr, string>> Of(uint pid) {
    var found = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var s = new StringBuilder(256); GetWindowText(h, s, 256);
        found.Add(new KeyValuePair<IntPtr, string>(h, s.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -AssemblyName System.Windows.Forms
[ResolveWin]::SetProcessDPIAware() | Out-Null

$proc = Get-Process Resolve -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_RESOLVE'; exit 2 }

function Console-Window { [ResolveWin]::Of($proc.Id) | Where-Object { $_.Value -eq 'Resolve' } | Select-Object -First 1 }

$console = Console-Window
if (-not $console) {
  $wins = [ResolveWin]::Of($proc.Id)
  $main = $wins | Where-Object { $_.Value -like 'DaVinci Resolve*' } | Select-Object -First 1
  # The Project Manager alone (no project open yet): it has no Console.
  if (-not $main -and ($wins | Where-Object { $_.Value -eq 'Project Manager' })) { Write-Output 'PROJECT_MANAGER'; exit 5 }
  if (-not $main) { Write-Output 'NO_WINDOW'; exit 3 }
  if ([ResolveWin]::IsIconic($main.Key)) { [ResolveWin]::ShowWindow($main.Key, 9) | Out-Null }
  [ResolveWin]::SetForegroundWindow($main.Key) | Out-Null
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait('{F6}')
  for ($i = 0; $i -lt 20 -and -not $console; $i++) { Start-Sleep -Milliseconds 150; $console = Console-Window }
  if (-not $console) { Write-Output 'NO_CONSOLE'; exit 4 }
}
if ([ResolveWin]::IsIconic($console.Key)) { [ResolveWin]::ShowWindow($console.Key, 9) | Out-Null }
[ResolveWin]::SetForegroundWindow($console.Key) | Out-Null
Start-Sleep -Milliseconds 300

# Click into the input line at the bottom of the Console, then put the mouse back.
$r = New-Object ResolveWin+RECT
[ResolveWin]::GetWindowRect($console.Key, [ref]$r) | Out-Null
$back = New-Object ResolveWin+POINT
[ResolveWin]::GetCursorPos([ref]$back) | Out-Null
[ResolveWin]::SetCursorPos([int](($r.L + $r.R) / 2), $r.B - 20) | Out-Null
[ResolveWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[ResolveWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
[ResolveWin]::SetCursorPos($back.X, $back.Y) | Out-Null
Start-Sleep -Milliseconds 200

$keys = ($line.ToCharArray() | ForEach-Object {
    if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ }
  }) -join ''
[System.Windows.Forms.SendKeys]::SendWait($keys + '{ENTER}')
Write-Output 'TYPED'
