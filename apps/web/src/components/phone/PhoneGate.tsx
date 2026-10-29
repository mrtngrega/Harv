import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { coverBoot, liftBoot } from '../../lib/boot.ts';
import type { PhoneState } from '@harv/shared';
import { askPairing, isIos, makePasskey, phoneState, registerWorker, sendCode, standalone, unlock } from '../../lib/phone.ts';
import { onSocketClosed, pauseSocket, resumeSocket, sendMessage, startSocket } from '../../lib/socket.ts';

// The phone's way in (docs/PLAN.md §6q): add to Home Screen → pair with a code shown on the
// computer → make the Face ID passkey → unlock with Face ID each time. Only then the dashboard.

type Stage = 'loading' | 'install' | 'pair' | 'code' | 'passkey' | 'locked' | 'open' | 'offline';

/** Hidden this long, the app locks itself (Face ID again when it comes back). */
const LOCK_AFTER_HIDDEN_MS = 5 * 60_000;

export function PhoneGate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>('loading');
  const [state, setState] = useState<PhoneState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [skipInstall, setSkipInstall] = useState(false);
  const hiddenAt = useRef(0);

  const check = useCallback(async () => {
    try {
      const s = await phoneState();
      setState(s);
      if (s.unlocked) {
        setStage('open');
        startSocket();
        resumeSocket();
        void registerWorker();
      } else {
        pauseSocket();
        setStage(s.needsPasskey ? 'passkey' : s.paired ? 'locked' : 'pair');
      }
    } catch (err) {
      const why = (err as Error).message;
      // Harv answered but doesn't let phones in (its Phone access is off): say so, it's not "offline".
      setError(
        /Phone access is off/.test(why)
          ? 'This computer’s Harv doesn’t let phones in yet: turn on Settings › Phone › “Open Harv from my phone” on it.'
          : /Tailscale account/.test(why)
            ? 'This phone’s Tailscale is signed in with a different account than the computer.'
            : '',
      );
      setStage('offline');
    }
  }, []);

  useEffect(() => {
    // The first look at the server: its answer (not this call) sets the stage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
  }, [check]);

  // The server ends a connection whose unlock ran out (4401): back to the Face ID screen.
  useEffect(() => onSocketClosed((code) => code === 4401 && void check()), [check]);

  // Away for a while: lock, so a phone left unlocked on a table doesn't stay open.
  useEffect(() => {
    const onVisible = () => {
      const visible = document.visibilityState === 'visible';
      sendMessage({ type: 'phone.visible', visible });
      if (!visible) hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > LOCK_AFTER_HIDDEN_MS) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      const msg = (err as Error).message;
      setError(/NotAllowed|cancel/i.test(msg) ? 'Face ID was cancelled. Try again.' : msg);
    } finally {
      setBusy(false);
    }
  };

  // The boot cover stays while connecting and over the dashboard until it's ready (App lifts it);
  // the pairing and Face ID screens show without it.
  useLayoutEffect(() => {
    if (stage === 'open') coverBoot();
    else if (stage !== 'loading') liftBoot();
  }, [stage]);

  if (stage === 'open') return <>{children}</>;

  const device = state?.device ?? 'your computer';
  const needsInstall = isIos && !standalone && !skipInstall && stage !== 'loading' && stage !== 'offline';

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5 py-10" style={{ background: '#0a1018' }}>
      <div className="glass flex w-full max-w-sm flex-col gap-5 rounded-2xl p-6 text-sm">
        <div className="flex items-center gap-3">
          <img src="/icon-180.png" alt="" className="h-10 w-10 rounded-xl" />
          <div>
            <div className="text-base font-semibold tracking-[0.12em] text-accent">HARV</div>
            <div className="text-xs text-faint">{state ? `on ${device}` : 'on your computer'}</div>
          </div>
        </div>

        {stage === 'loading' && <p className="text-muted">Connecting…</p>}

        {stage === 'offline' && (
          <>
            {!error && (
              <p className="text-muted">Can’t reach Harv. Check that the computer is on, Harv is running, and Tailscale is on here.</p>
            )}
            <Button onClick={() => void check()}>Try again</Button>
            {document.referrer && !document.referrer.startsWith(location.origin) && (
              <button type="button" className="self-start text-xs text-faint underline" onClick={() => history.back()}>
                Back to the other computer
              </button>
            )}
          </>
        )}

        {needsInstall && (
          <>
            <p className="text-ink">Put Harv on your Home Screen first.</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>Tap Share (the square with the arrow) below.</li>
              <li>Tap “Add to Home Screen”, then Add.</li>
              <li>Open Harv from your Home Screen and pair it there.</li>
            </ol>
            <p className="text-xs text-faint">The Home Screen app keeps its own sign-in, so pairing in Safari wouldn’t carry over.</p>
            <button type="button" className="self-start text-xs text-faint underline" onClick={() => setSkipInstall(true)}>
              Use it in Safari instead
            </button>
          </>
        )}

        {!needsInstall && stage === 'pair' && (
          <>
            <p className="text-ink">Pair this phone with {device}.</p>
            <p className="text-muted">Harv shows a 6-digit code on {device}. You type it here.</p>
            <Button
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await askPairing();
                  setStage('code');
                })
              }
            >
              Show a code on {device}
            </Button>
          </>
        )}

        {!needsInstall && stage === 'code' && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await sendCode(code);
                if (r.ok) return check();
                setCode('');
                if (!r.left) {
                  setStage('pair');
                  throw new Error('Too many wrong codes. Ask for a new one.');
                }
                throw new Error(`That’s not the code. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.`);
              });
            }}
          >
            <label htmlFor="pair-code" className="text-muted">
              The code on {device}:
            </label>
            <input
              id="pair-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="rounded-lg border border-line bg-black/30 px-3 py-3 text-center text-2xl tracking-[0.5em] text-ink outline-none focus:border-accent"
            />
            <Button busy={busy} disabled={code.length !== 6} type="submit">
              Pair
            </Button>
          </form>
        )}

        {!needsInstall && stage === 'passkey' && (
          <>
            <p className="text-ink">Paired. Now set up Face ID.</p>
            <p className="text-muted">Harv asks for Face ID each time you open it, so nobody else can use your PC from this phone.</p>
            <Button busy={busy} onClick={() => void run(async () => (await makePasskey(), check()))}>
              Set up Face ID
            </Button>
          </>
        )}

        {!needsInstall && stage === 'locked' && (
          <>
            <Button busy={busy} onClick={() => void run(async () => (await unlock(), check()))}>
              Unlock with Face ID
            </Button>
            {/* The passkey never got saved on the phone (or was deleted): pair again, with a new code from the computer. */}
            {error && (
              <button
                type="button"
                className="self-start text-xs text-faint underline"
                onClick={() =>
                  void run(async () => {
                    await askPairing();
                    setStage('code');
                  })
                }
              >
                Face ID keeps failing? Pair this phone again
              </button>
            )}
          </>
        )}

        {error && <p className="text-warn">{error}</p>}
      </div>
    </div>
  );
}

function Button({
  children,
  onClick,
  busy,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy || disabled}
      className="rounded-lg border border-accent/50 bg-accent/15 px-4 py-3 text-ink transition-colors active:bg-accent/25 disabled:opacity-50"
    >
      {busy ? 'One moment…' : children}
    </button>
  );
}
