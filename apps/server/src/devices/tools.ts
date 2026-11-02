import type { AutoLightsStatus, HarvSettings, LightChange, LightControlBy, LightState } from '@harv/shared';
import { COLOR_NAMES, parseColor } from './colors.ts';
import type { LightsService } from './lights.ts';

// Harv's lights_list / lights_set tools (docs/PLAN.md §6z), as plain text for the model.

/** What a chat asks a light to do. */
export interface LightRequest {
  on?: boolean;
  /** 1–100. */
  brightness?: number;
  /** A colour or white by name ("teal", "warm white"), hex ("#ff8800") or kelvin ("2700K"). */
  color?: string;
  /** A built-in effect's name, or "off". */
  effect?: string;
  /** Automatic lights: false pauses them (until Harv starts again), true turns them back on. */
  auto?: boolean;
}

export interface LightTools {
  describe(): Promise<string>;
  set(light: string | undefined, request: LightRequest): Promise<string>;
}

export function describeLight(l: LightState): string {
  if (!l.reachable) return `${l.name}: can't be reached (${l.error ?? 'no answer'})`;
  if (!l.on) return `${l.name}: off`;
  const look = l.effect ? `effect ${l.effect}` : l.temp ? `white ${l.temp}K` : `colour hue ${l.hue}° saturation ${l.saturation}%`;
  return `${l.name}: on, ${l.brightness}% brightness, ${look}`;
}

const WHO: Record<LightControlBy, string> = {
  auto: 'automatic lights',
  you: 'the user (dashboard)',
  chat: 'a chat or Siri',
  outside: 'outside Harv (Tapo app, its button, the other computer)',
};
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Automatic lights for the model (the user's report, 2026-11-01: a chat said "no auto-light rule
 * exists" because it only looked at scheduled tasks): what they are, the settings and what they
 * see and did right now.
 */
export function describeAuto(
  auto: AutoLightsStatus | undefined,
  cfg: Pick<HarvSettings, 'autoLights' | 'autoLightsPlace' | 'autoLightsDark' | 'autoLightsSunset' | 'autoLightsAway'>,
  lights: LightState[],
): string {
  const lines = [
    'Automatic lights (built into Harv, Settings › Devices; not a scheduled task): the strip goes on when it’s dark outside (Open-Meteo sunlight on the ground below the threshold, or from a while before sunset until sunrise) and the user is at this computer (input in the last 2 minutes, or a video/full-screen app/gamepad), at the moment they touch the mouse or keyboard; it goes off when they’re away, at daylight, or when the computer sleeps or shuts down. Always in charge: whoever switched the light, it acts again at its next change (the user leaves, comes back, it gets dark or light); a hand switch in between holds until then. The AUTO button next to the strip’s switch (or lights_set auto) pauses it until Harv starts again.',
  ];
  if (!cfg.autoLights) return [...lines, 'State: switched off in Settings.'].join('\n');
  if (auto?.paused) lines.push('Paused right now (the AUTO button), until it’s pressed again or Harv starts again.');
  lines.push(
    `Settings: on; place ${cfg.autoLightsPlace?.name ?? 'not set'}; dark below ${cfg.autoLightsDark} W/m²; ${cfg.autoLightsSunset} min before sunset; away after ${cfg.autoLightsAway} min.`,
  );
  if (auto) {
    const seen = [
      auto.sunlight !== undefined
        ? `sunlight ${auto.sunlight} W/m²${auto.weatherAt ? ` (read ${clock(auto.weatherAt)})` : ''}`
        : 'no sunlight reading',
      auto.sunset ? `sunset ${clock(auto.sunset)}` : '',
      auto.dark ? 'counts as dark' : 'counts as light',
      auto.idleSec !== undefined ? `last input ${auto.idleSec} s ago` : '',
      auto.watching ?? '',
    ].filter(Boolean);
    lines.push(`Now: ${seen.join('; ')}. Doing: ${auto.why || 'nothing yet'}.`);
    if (auto.last) lines.push(`Last switch: ${auto.last.action} at ${clock(auto.last.at)} (${auto.last.why}).`);
    if (auto.problem) lines.push(`Problem: ${auto.problem}`);
  }
  for (const l of lights)
    if (l.control)
      lines.push(`${l.name} was last switched by ${WHO[l.control.by]} at ${clock(l.control.seenAt ?? l.control.at)}: ${l.control.what}.`);
  return lines.join('\n');
}

/** The request as the strip takes it, or a reason it can't be. */
export function toChange(request: LightRequest): LightChange | string {
  const change: LightChange = {};
  if (typeof request.on === 'boolean') change.on = request.on;
  if (typeof request.brightness === 'number') change.brightness = request.brightness;
  if (request.color) {
    const color = parseColor(request.color);
    if (!color)
      return `"${request.color}" isn't a colour I know: use a name (${COLOR_NAMES.join(', ')}), a hex code like #ff8800, or kelvin like 2700K.`;
    Object.assign(change, color);
  }
  if (request.effect) change.effect = request.effect;
  return Object.keys(change).length ? change : 'Say what to change: on/off, brightness, a colour or an effect.';
}

export function lightTools(service: LightsService, settings: () => HarvSettings): LightTools {
  return {
    async describe() {
      const status = service.status();
      if (status.setup === 'missing')
        return 'The light helper isn’t installed on this computer yet: the user installs it in Settings › Devices.';
      if (status.setup === 'nologin') return 'No Tapo login yet: the user saves it in Settings › Devices.';
      const lights = await service.refresh();
      if (!status.lights.length) return 'Harv controls no lights yet: the user picks them in Settings › Devices.';
      const effects = lights.find((l) => l.effects?.length)?.effects;
      const shown = lights.length ? lights : status.lights;
      return [
        ...shown.map(describeLight),
        ...(effects ? [`Effects: ${effects.join(', ')}`] : []),
        '',
        describeAuto(service.status().auto, settings(), shown),
      ].join('\n');
    },
    async set(light, request) {
      const targets = service.match(light);
      if (!targets.length)
        return `No light called "${light}". Harv controls: ${
          service
            .match(undefined)
            .map((l) => l.name)
            .join(', ') || 'none yet'
        }.`;
      const { auto, ...look } = request;
      const out: string[] = [];
      if (auto !== undefined) {
        service.autoPause?.(!auto);
        out.push(auto ? 'Automatic lights are back on.' : 'Automatic lights are paused until they’re turned back on or Harv starts again.');
        if (!Object.keys(look).length) return out.join('\n');
      }
      const change = toChange(look);
      if (typeof change === 'string') return change;
      for (const t of targets) {
        try {
          out.push(describeLight(await service.set(t.id, change, 'chat')));
        } catch (err) {
          out.push(`${t.name}: ${(err as Error).message}`);
        }
      }
      return out.join('\n');
    },
  };
}
