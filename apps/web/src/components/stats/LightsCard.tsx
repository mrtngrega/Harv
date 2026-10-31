import { useEffect, useRef, useState } from 'react';
import { swatch, type LightState } from '@harv/shared';
import { lights, QUICK_COLORS, useLights } from '../../lib/lights.ts';
import { Card } from './parts.tsx';

// The user's light strip in the stats panel (docs/PLAN.md §6z): a row per light when narrow, the
// controls when expanded. Hidden until Harv controls a light.

const colorOf = (l: LightState) => (l.on ? swatch(l) : 'transparent');

/** On/off as a round swatch: its colour when on, an empty ring when off. */
function Switch({ light }: { light: LightState }) {
  return (
    <button
      type="button"
      disabled={!light.reachable}
      onClick={() => lights.set(light.id, { on: !light.on })}
      aria-label={`${light.name}: ${light.on ? 'on, turn off' : 'off, turn on'}`}
      aria-pressed={!!light.on}
      title={light.reachable ? (light.on ? 'Turn off' : 'Turn on') : (light.error ?? 'Not reachable')}
      className="size-4 flex-none cursor-pointer rounded-full border border-[rgb(220_232_245/0.35)] disabled:cursor-default disabled:opacity-40"
      style={{ background: colorOf(light), boxShadow: light.on ? `0 0 8px ${colorOf(light)}` : undefined }}
    />
  );
}

/** One row per light in the narrow panel. */
export function LightsCompact() {
  const status = useLights();
  if (!status?.lights.length) return null;
  return (
    <>
      <div className="mx-2 border-t border-line" />
      {status.lights.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-2 px-2 text-[11px]">
          <span className="min-w-0 truncate text-muted" title={l.name}>
            {l.name}
          </span>
          <span className="flex flex-none items-center gap-1.5 tabular-nums">
            <span className={l.reachable ? 'text-ink' : 'text-faint'}>{!l.reachable ? '—' : l.on ? `${l.brightness ?? ''}%` : 'off'}</span>
            <Switch light={l} />
          </span>
        </div>
      ))}
    </>
  );
}

/** Brightness: moves freely, sent once the slider is let go (and at most every 400 ms while dragging). */
function Brightness({ light }: { light: LightState }) {
  const [value, setValue] = useState(light.brightness ?? 100);
  const dragging = useRef(false);
  const last = useRef(0);
  useEffect(() => {
    if (!dragging.current && light.brightness !== undefined) setValue(light.brightness);
  }, [light.brightness]);
  const send = (v: number, force = false) => {
    const now = Date.now();
    if (!force && now - last.current < 400) return;
    last.current = now;
    lights.set(light.id, { brightness: v });
  };
  return (
    <label className="flex items-center gap-2 text-[11px] text-muted">
      <span className="w-16 flex-none">Brightness</span>
      <input
        type="range"
        min={1}
        max={100}
        value={value}
        disabled={!light.reachable}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => {
          setValue(Number(e.target.value));
          send(Number(e.target.value));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          send(Number((e.target as HTMLInputElement).value), true);
        }}
        onKeyUp={(e) => send(Number((e.target as HTMLInputElement).value), true)}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      <span className="w-9 flex-none text-right text-ink tabular-nums">{value}%</span>
    </label>
  );
}

export function LightsCard() {
  const status = useLights();
  if (!status?.lights.length) return null;
  return (
    <>
      {status.lights.map((l) => (
        <Card
          key={l.id}
          title={l.name}
          sub={!l.reachable ? (l.error ?? 'not reachable') : l.effect ? l.effect : l.temp ? `white ${l.temp}K` : l.on ? 'colour' : ''}
          value={l.reachable ? (l.on ? 'on' : 'off') : '—'}
        >
          <div className="flex items-center gap-3">
            <Switch light={l} />
            <span className="text-[11px] text-muted">{l.on ? 'Tap to turn off' : 'Tap to turn on'}</span>
          </div>
          {l.reachable && (
            <>
              <Brightness light={l} />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colours">
                {QUICK_COLORS.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => lights.set(l.id, c.change)}
                    className="size-5 cursor-pointer rounded-full border border-[rgb(220_232_245/0.25)] hover:scale-110"
                    style={{ background: swatch(c.change) }}
                  />
                ))}
              </div>
              {!!l.effects?.length && (
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="w-16 flex-none">Effect</span>
                  <select
                    value={l.effect ?? 'Off'}
                    onChange={(e) => lights.set(l.id, { effect: e.target.value })}
                    className="min-h-7 min-w-0 flex-1 rounded-md border border-line bg-black/30 px-1.5 text-[11px] text-ink"
                  >
                    <option value="Off">None</option>
                    {l.effects.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </Card>
      ))}
    </>
  );
}
