import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WINDOWS_MCP_ARGS, WINDOWS_MCP_ENV, WINDOWS_MCP_VERSION } from './windowsMcp.ts';

describe('Windows-MCP start-up (docs/PLAN.md §6t item 1)', () => {
  it('always runs with its telemetry off', () => {
    expect(WINDOWS_MCP_ENV.ANONYMIZED_TELEMETRY).toBe('false');
  });

  it('starts only the reviewed tools, never its own shell, files, registry, processes or web', () => {
    const tools = WINDOWS_MCP_ENV.WINDOWS_MCP_TOOLS!.split(',');
    expect(tools).toContain('Snapshot');
    expect(tools).toContain('Click');
    for (const banned of ['PowerShell', 'FileSystem', 'Registry', 'Process', 'Scrape']) expect(tools).not.toContain(banned);
  });

  it('pins the reviewed version', () => {
    expect(WINDOWS_MCP_VERSION).toBe('0.8.8');
  });

  it("starts through Harv's quiet launcher (no glow, notice pill or flash: Harv's pill is the indicator)", () => {
    expect(WINDOWS_MCP_ARGS[0]).toBe('-I');
    expect(existsSync(WINDOWS_MCP_ARGS[1]!)).toBe(true);
    expect(WINDOWS_MCP_ARGS.slice(2)).toEqual(['serve', '--transport', 'stdio']);
    expect(WINDOWS_MCP_ENV.WINDOWS_MCP_DISABLE_FLASH).toBe('1');
  });
});
