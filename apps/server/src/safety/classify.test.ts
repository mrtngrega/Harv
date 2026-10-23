import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'harv-safety-'));
vi.stubEnv('HARV_HOME', home);
const { classify, classifyCommand, pathsInCommand, splitCommand } = await import('./classify.ts');
const { isInside, toWindowsPath } = await import('./paths.ts');

const userDir = mkdtempSync(join(tmpdir(), 'harv-user-'));
const userFile = join(userDir, 'notes.txt');
writeFileSync(userFile, 'hello');
const protectedDir = join(userDir, 'Photos');
mkdirSync(protectedDir);
writeFileSync(join(home, 'settings.json'), JSON.stringify({ protectedPaths: [protectedDir] }));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

const tier = (tool: string, input: Record<string, unknown>) => classify(tool, input).tier;
const cmd = (command: string) => classifyCommand(command).tier;

describe('paths', () => {
  it('understands Git Bash and relative paths', () => {
    expect(toWindowsPath('/c/Users/me/a.txt')).toBe('C:\\Users\\me\\a.txt');
    expect(toWindowsPath('C:/Windows/System32')).toBe('C:\\Windows\\System32');
    expect(isInside('c:\\windows\\system32\\x.dll', 'C:\\Windows')).toBe(true);
    expect(isInside('C:\\WindowsApps\\x', 'C:\\Windows')).toBe(false);
  });
});

describe('reading', () => {
  it('is green on ordinary paths', () => {
    expect(tier('Read', { file_path: 'C:\\Users\\me\\Documents\\notes.md' })).toBe('green');
    expect(tier('WebSearch', { query: 'weather' })).toBe('green');
    expect(tier('mcp__harv__read_chat', { id: 'x' })).toBe('green');
    expect(tier('Read', { file_path: 'C:\\notes\\environment.md' })).toBe('green');
  });

  it.each([
    'C:\\Users\\me\\.claude\\.credentials.json',
    'C:/Users/me/.ssh/id_ed25519',
    'C:\\project\\.env',
    'C:\\project\\.env.local',
    'D:\\backup\\passwords.kdbx',
    'C:\\keys\\server.pem',
  ])('never reads secrets: %s', (path) => {
    expect(tier('Read', { file_path: path })).toBe('blocked');
  });

  it('checks search roots too', () => {
    expect(tier('Glob', { pattern: '**/*', path: 'C:\\Users\\me\\.claude' })).toBe('blocked');
  });

  it('refuses tools Harv does not have', () => {
    expect(tier('Agent', {})).toBe('blocked');
  });
});

describe('writing files', () => {
  it('is green in the workspace, yellow for user files', () => {
    expect(tier('Write', { file_path: join(home, 'workspace', 'draft.md') })).toBe('green');
    const edit = classify('Edit', { file_path: userFile });
    expect(edit.tier).toBe('yellow');
    expect(edit.targets).toEqual([userFile]);
    expect(classify('Write', { file_path: join(userDir, 'new.txt') }).summary).toMatch(/^create /);
  });

  it('blocks Windows, protected folders and Harv’s own data', () => {
    expect(tier('Write', { file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' })).toBe('blocked');
    expect(tier('Edit', { file_path: join(protectedDir, 'a.jpg') })).toBe('blocked');
    expect(tier('Write', { file_path: join(home, 'harv.db') })).toBe('blocked');
    expect(tier('Write', { file_path: join(home, 'memory', 'x.md') })).toBe('blocked');
  });

  it('asks before changing installed programs', () => {
    expect(tier('Write', { file_path: 'C:\\Program Files\\App\\config.ini' })).toBe('red');
  });
});

describe('shell commands', () => {
  it.each([
    'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
    'ls -la ~/Documents',
    'dir C:\\Users',
    'git status && git log --oneline -5',
    'nvidia-smi',
    'tasklist /FI "IMAGENAME eq chrome.exe"',
    'Get-ChildItem C:\\Windows\\Temp',
    'Get-Content notes.txt 2>$null',
    'start notepad',
    'Start-Process https://example.com',
    'explorer C:\\Users\\me\\Downloads',
  ])('green: %s', (command) => {
    expect(cmd(command)).toBe('green');
  });

  it.each([
    ['Remove-Item C:\\Users\\me\\old -Recurse', /Deletes/],
    ['rm -rf ~/tmp/cache', /Deletes/],
    ['winget install Mozilla.Firefox', /Installs/],
    ['taskkill /IM chrome.exe /F', /Stops/],
    ['Stop-Process -Name notepad', /Stops/],
    ['reg add HKCU\\Software\\Test /v X /d 1', /registry/],
    ['git push origin main', /git remote/],
    ['python script.py', /script/],
    ['echo hi > out.txt', /Writes/],
    ['Get-ChildItem | ForEach-Object { Remove-Item $_ }', /Deletes/],
    ['find . -name "*.log" -delete', /could change/],
    ['Start-Process cmd -Verb RunAs', /./],
    ['start C:\\Users\\me\\Downloads\\setup.exe', /./],
    ['Invoke-Expression (Get-Content x.ps1)', /./],
    ['Get-Date; $(rm x)', /./],
    ['npm install left-pad', /Installs/],
  ])('red: %s', (command, reason) => {
    const v = classifyCommand(command);
    expect(v.tier).toBe('red');
    expect(v.reason).toMatch(reason);
  });

  it.each([
    'format D: /q',
    'Format-Volume -DriveLetter E',
    'diskpart',
    'Set-MpPreference -DisableRealtimeMonitoring $true',
    'netsh advfirewall set allprofiles state off',
    'Remove-NetFirewallRule -DisplayName "Harv: block remote access"',
    'cmdkey /list',
    'cat ~/.claude/.credentials.json',
    'Remove-Item C:\\Windows\\Temp\\x.log',
    'del /c/Windows/System32/foo.dll',
  ])('blocked: %s', (command) => {
    expect(cmd(command)).toBe('blocked');
  });

  it('blocks changes to protected folders but still lets Harv look', () => {
    expect(cmd(`Remove-Item "${protectedDir}" -Recurse`)).toBe('blocked');
    expect(cmd(`Get-ChildItem "${protectedDir}"`)).toBe('green');
  });

  it('finds the files a command touches, for the backup', () => {
    expect(pathsInCommand(`Remove-Item "${userFile}" -Force`)).toEqual([userFile]);
    expect(classifyCommand(`del "${userFile}"`).targets).toEqual([userFile]);
    expect(pathsInCommand('taskkill /IM chrome.exe /F')).toEqual([]);
  });

  it('splits command chains', () => {
    expect(splitCommand('a && b; c | d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
