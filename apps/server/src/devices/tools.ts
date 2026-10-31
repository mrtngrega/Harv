import type { LightChange, LightState } from '@harv/shared';
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

export function lightTools(service: LightsService): LightTools {
  return {
    async describe() {
      const status = service.status();
      if (status.setup === 'missing')
        return 'The light helper isn’t installed on this computer yet: the user installs it in Settings › Devices.';
      if (status.setup === 'nologin') return 'No Tapo login yet: the user saves it in Settings › Devices.';
      const lights = await service.refresh();
      if (!status.lights.length) return 'Harv controls no lights yet: the user picks them in Settings › Devices.';
      const effects = lights.find((l) => l.effects?.length)?.effects;
      return [...(lights.length ? lights : status.lights).map(describeLight), ...(effects ? [`Effects: ${effects.join(', ')}`] : [])].join(
        '\n',
      );
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
      const change = toChange(request);
      if (typeof change === 'string') return change;
      const out: string[] = [];
      for (const t of targets) {
        try {
          out.push(describeLight(await service.set(t.id, change)));
        } catch (err) {
          out.push(`${t.name}: ${(err as Error).message}`);
        }
      }
      return out.join('\n');
    },
  };
}
