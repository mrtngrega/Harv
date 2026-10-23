import { describe, expect, it } from 'vitest';
import { describeTool } from './guard.ts';

describe('describeTool', () => {
  it('summarizes the call', () => {
    expect(describeTool('Read', { file_path: 'a.txt' })).toBe('a.txt');
    expect(describeTool('Grep', { pattern: 'todo', path: 'src' })).toBe('todo in src');
    expect(describeTool('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
    expect(describeTool('PowerShell', { command: 'Get-Process\nGet-Date' })).toBe('Get-Process');
    expect(describeTool('mcp__harv__list_chats', { query: 'gpu' })).toBe('gpu');
    expect(describeTool('mcp__harv__read_chat', { id: 'abc' }, () => 'Weather')).toBe('"Weather"');
    expect(describeTool('mcp__harv__read_chat', { id: '0123456789' }, () => undefined)).toBe('01234567');
  });
});
