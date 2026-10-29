/**
 * Notices when a reply is going badly, so AUTO can step up mid-reply (docs/PLAN.md §5, "quality
 * nets"; built 2026-10-29, the user's pick: quality over saving usage). Signals, in one reply:
 * - tests, a build or a script failing (a test runner's "3 failed", a traceback, a type error): at once;
 * - two failed tool calls in a row (a command that errors, an edit that can't apply);
 * - Harv saying it isn't sure or that its fix didn't work, after a failed tool call.
 * A tool call that works clears the count. Searches that find nothing (grep's exit code 1) aren't failures.
 */

/** Test runners, builds and scripts saying something broke. */
const BROKE =
  /\b[1-9]\d* (failed|failing|errors?)\b|\bTests?:?\s+[1-9]\d* failed|^# fail [1-9]|^\s*(FAIL|FAILED)\b|AssertionError|Traceback \(most recent call last\)|\berror (TS|CS)\d+|BUILD FAILED|npm ERR!|\bpanicked at\b|error\[E\d+\]|SyntaxError:|ReferenceError:|TypeError:/m;

/** Commands whose "error" only means they found nothing (or that two things differ). */
const SEARCH =
  /^\s*(grep|egrep|fgrep|rg|ag|findstr|select-string|sls|find|where|which|get-command|gcm|test-path|test|\[|diff|cmp|git\s+(diff|grep)|pgrep|tasklist)\b/i;

/** Harv saying it's stuck. Only counts right after a failure (plain caution isn't struggling). */
const STUCK =
  /\b(i'?m not sure (why|what|how)|i am not sure (why|what|how)|not certain (why|what)|i can'?t (figure out|tell why|see why)|unclear why|(still|keeps?) (fail(s|ing)?|broken|erroring)|(that|this) didn'?t (work|fix it|help)|doesn'?t seem to (work|help))\b/i;

/** How many failures in a row make a step up. */
const IN_A_ROW = 2;

export class StruggleWatch {
  private commands = new Map<string, string>();
  private fails = 0;
  private lastFailed = false;

  /** A new reply starts: nothing counts yet. */
  reset(): void {
    this.commands.clear();
    this.fails = 0;
    this.lastFailed = false;
  }

  /** Harv called a tool (`command` for shell tools). */
  toolUse(id: string, command?: string): void {
    if (command) this.commands.set(id, command);
  }

  /** A tool's result. Returns why to step up, or null. */
  toolResult(id: string, isError: boolean, output: string): string | null {
    const command = this.commands.get(id);
    this.commands.delete(id);
    const broke = BROKE.test(output.slice(-20_000));
    if (broke && command && !SEARCH.test(command)) return this.step(`${what(command)} failed`);
    if (!isError || (command && SEARCH.test(command))) {
      this.fails = 0;
      this.lastFailed = false;
      return null;
    }
    this.fails += 1;
    this.lastFailed = true;
    if (this.fails >= IN_A_ROW) return this.step(`${this.fails} tool calls failed in a row`);
    return null;
  }

  /** Something Harv wrote mid-reply. Returns why to step up, or null. */
  said(text: string): string | null {
    if (!this.lastFailed || !STUCK.test(text)) return null;
    return this.step('it got stuck after a failure');
  }

  private step(why: string): string {
    this.fails = 0;
    this.lastFailed = false;
    return why;
  }
}

/** "the tests" for a test command, else the command's first word. */
function what(command: string): string {
  if (/\b(test|vitest|jest|pytest|mocha|cargo test|go test|dotnet test)\b/i.test(command)) return 'the tests';
  if (/\b(build|tsc|cargo build|make|gradle|mvn|javac)\b/i.test(command)) return 'the build';
  return `\`${command.trim().split(/\s+/)[0]}\``;
}
