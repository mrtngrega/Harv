# Diagnosing the computer or an app

The same steps as for code; only the loop looks different. Here the loop is a **reading** that shows the symptom: a number (CPU %, temperature, free space, ping, start-up time), a log line, an error dialog's exact text, or "does X happen when I do Y". Take it before changing anything, so the fix can be proved by taking it again.

## Where the readings are

- **Harv's own stats**: CPU, GPU, RAM, disks, network, temperatures, fans, top processes (the stats panel; Harv reads them every second). The watchdog's alerts (overheating, background hogs, Defender, miners) are in Harv's logs.
- **Windows**: Event Viewer (`Get-WinEvent -LogName System,Application -MaxEvents 50`, filter by level and time), Reliability Monitor (`Get-CimInstance Win32_ReliabilityRecords`), `Get-Process | Sort CPU -Desc`, `Get-Counter`, `powercfg /requests` (what keeps the PC or screen awake; needs admin), `powercfg /sleepstudy`, Device Manager problems (`Get-PnpDevice | Where Status -ne OK`), `netstat -ano`, `Test-NetConnection`, `ipconfig /all`, crash dumps in `%LOCALAPPDATA%\CrashDumps` and `C:\Windows\Minidump`.
- **Fedora (KDE)**: `journalctl -b -p warning`, `journalctl -b -1` (the boot before: what happened before a crash or a hard power-off), `journalctl --user -u <service>`, `systemctl --failed`, `dmesg`, `coredumpctl list`, `sensors`, `top`/`htop`, `nmcli`, `ss -tlnp`, `ausearch -m avc -ts recent` (SELinux denials, often why something "has no permission" with correct file rights).
- **An app's own log**: most apps keep one (`%APPDATA%`, `%LOCALAPPDATA%`, `~/.local/share`, `~/.config`, `~/.cache`). Read the lines around the time it happened.

## Habits that matter here

- **Note the time** the user saw it, then read every log around that time. "Yesterday evening" is enough to start: narrow it with the logs.
- **Start cheap**: an overview first (top processes, free space, the last errors), then dig into the one or two suspects. Scans over a whole drive take minutes: say so before starting one.
- **One change at a time**, and the reading again after each: a driver, a setting, a program closed. Write down what you changed, so it can be put back.
- **Hardware shows in numbers**: temperatures near the limit, a disk's SMART errors (`Get-PhysicalDisk`, `smartctl -a`), RAM errors in the logs, a charger that doesn't charge. Say plainly when it looks like hardware and nothing in software will fix it.
- **Risky fixes** (uninstalling, registry, BIOS, drivers, deleting files): say what you're about to do and why, back up first, and pick the least risky way. Harv's safety gate backs up and logs, but the user should know before the PC changes.
- **Proof** is the same reading, taken again under the same conditions, showing the symptom gone. "It should be better now" isn't proof.
