import { describe, expect, it } from 'vitest';
import { stripBilledCredentials } from './env.ts';

describe('stripBilledCredentials', () => {
  it('removes API credentials so Claude can only use the subscription login', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      PATH: '/bin',
    };
    expect(stripBilledCredentials(env)).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('reports nothing when no credentials are set', () => {
    expect(stripBilledCredentials({ PATH: '/bin' })).toEqual([]);
  });
});
