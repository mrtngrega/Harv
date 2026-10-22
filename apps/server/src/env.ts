// Harv runs only on the user's Claude subscription. If an API key or auth token
// were present, Claude Code / the Agent SDK would use it and bill per token, so
// strip them from this process before anything else can read them.
const BILLED_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export function stripBilledCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of BILLED_CREDENTIAL_VARS) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
