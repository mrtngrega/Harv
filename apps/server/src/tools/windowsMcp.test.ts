import { describe, expect, it } from 'vitest';
import { WINDOWS_MCP_ENV, WINDOWS_MCP_VERSION } from './windowsMcp.ts';

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
});
