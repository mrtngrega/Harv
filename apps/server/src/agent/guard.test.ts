import { describe, expect, it } from 'vitest';
import { checkTool, describeTool } from './guard.ts';

describe('checkTool', () => {
  it('allows read-only tools on ordinary paths', () => {
    expect(checkTool('Read', { file_path: 'C:\\Users\\me\\Documents\\notes.md' })).toEqual({ allow: true });
    expect(checkTool('WebSearch', { query: 'weather' })).toEqual({ allow: true });
  });

  it('denies tools that run commands or change files until the safety gate exists', () => {
    for (const name of ['Bash', 'Write', 'Edit', 'PowerShell']) {
      expect(checkTool(name, {}).allow).toBe(false);
    }
  });

  it.each([
    'C:\\Users\\me\\.claude\\.credentials.json',
    'C:/Users/me/.ssh/id_ed25519',
    'C:\\project\\.env',
    'C:\\project\\.env.local',
    'D:\\backup\\passwords.kdbx',
    'C:\\keys\\server.pem',
  ])('never reads secrets: %s', (path) => {
    expect(checkTool('Read', { file_path: path }).allow).toBe(false);
  });

  it('checks search patterns and roots too', () => {
    expect(checkTool('Glob', { pattern: '**/*', path: 'C:\\Users\\me\\.claude' }).allow).toBe(false);
    expect(checkTool('Grep', { pattern: 'token', path: 'C:\\Users\\me\\.aws' }).allow).toBe(false);
  });

  it('does not flag look-alike names', () => {
    expect(checkTool('Read', { file_path: 'C:\\notes\\environment.md' })).toEqual({ allow: true });
  });
});

describe('describeTool', () => {
  it('summarizes the call', () => {
    expect(describeTool('Read', { file_path: 'a.txt' })).toBe('a.txt');
    expect(describeTool('Grep', { pattern: 'todo', path: 'src' })).toBe('todo in src');
    expect(describeTool('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
  });
});
