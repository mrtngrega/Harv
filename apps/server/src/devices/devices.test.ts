import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { swatch } from '@harv/shared';
import { fitTemp, parseColor } from './colors.ts';
import { broadcastTargets, LightsService } from './lights.ts';
import { DeviceStore } from './store.ts';
import { describeLight, toChange } from './tools.ts';

const dir = mkdtempSync(join(tmpdir(), 'harv-devices-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MINE = 'EC:75:0C:EA:F1:9F';
const OTHER = 'EC:75:0C:EA:F0:3C';

describe('colours as said', () => {
  it('knows names, whites, hex and kelvin', () => {
    expect(parseColor('teal')).toEqual({ hue: 175, saturation: 100 });
    expect(parseColor('  Warm   White ')).toEqual({ temp: 2700 });
    expect(parseColor('#ff0000')).toEqual({ hue: 0, saturation: 100 });
    expect(parseColor('#0000ff')).toEqual({ hue: 240, saturation: 100 });
    expect(parseColor('f80')).toEqual({ hue: 32, saturation: 100 });
    expect(parseColor('2700K')).toEqual({ temp: 2700 });
    expect(parseColor('6500')).toEqual({ temp: 6500 });
    expect(parseColor('banana')).toBeNull();
  });
  it('keeps whites within what the light can do', () => {
    expect(fitTemp(1800)).toBe(2500);
    expect(fitTemp(12000, [2500, 9000])).toBe(9000);
  });
  it('draws a swatch for the dashboard', () => {
    expect(swatch({ hue: 0, saturation: 100 })).toBe('#ff0000');
    expect(swatch({ hue: 120, saturation: 100 })).toBe('#00ff00');
    expect(swatch({ temp: 2500 })).toBe('#ffbe82');
  });
});

describe('home network broadcast addresses', () => {
  it('leaves out Tailscale, Hamachi, link-local and loopback', () => {
    const iface = (address: string, netmask: string, internal = false) => ({
      address,
      netmask,
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal,
      cidr: null,
    });
    expect(
      broadcastTargets({
        Ethernet: [iface('192.168.1.10', '255.255.255.0')],
        Tailscale: [iface('100.101.5.7', '255.255.255.255')],
        Hamachi: [iface('25.12.4.9', '255.0.0.0')],
        APIPA: [iface('169.254.3.3', '255.255.0.0')],
        Loopback: [iface('127.0.0.1', '255.0.0.0', true)],
        Office: [iface('10.0.4.20', '255.255.252.0')],
      }),
    ).toEqual(['192.168.1.255', '10.0.7.255']);
  });
});

describe('the devices file', () => {
  it('keeps the login, the chosen lights and the refused ones; a new login clears refusals', () => {
    const store = new DeviceStore(join(dir, 'a.json'));
    expect(store.read()).toEqual({});
    store.setTapo({ email: ' me@example.com ', password: 'pw' });
    store.setChosen(MINE, true);
    store.refuse(OTHER);
    expect(store.read()).toEqual({ tapo: { email: 'me@example.com', password: 'pw' }, lights: [MINE], refused: [OTHER] });
    expect(store.summary()).toEqual({ tapoEmail: 'me@example.com' });
    expect(JSON.stringify(store.summary())).not.toContain('pw');
    store.setTapo({ email: 'me@example.com', password: 'new' });
    expect(store.read().refused).toEqual([]);
    expect(store.read().lights).toEqual([MINE]);
    store.setChosen(MINE, false);
    expect(store.read().lights).toEqual([]);
  });
  it('survives a broken or odd file', () => {
    const file = join(dir, 'b.json');
    const store = new DeviceStore(file);
    store.setTapo(null);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ refused: [] });
    const odd = new DeviceStore(join(dir, 'nope', 'c.json'));
    expect(odd.read()).toEqual({});
  });
});

describe('only the chosen light, never one that refused the login', () => {
  const store = new DeviceStore(join(dir, 'd.json'));
  const service = new LightsService(store, { broadcast: () => {}, log: () => {}, watchers: () => 0 });
  store.setTapo({ email: 'me@example.com', password: 'pw' });
  store.setChosen(MINE, true);

  it('refuses a light the user didn’t choose, and one that refused the login', async () => {
    await expect(service.set(OTHER, { on: true })).rejects.toThrow(/doesn’t control that light/);
    store.setChosen(OTHER, true);
    store.refuse(OTHER);
    await expect(service.set(OTHER, { on: true })).rejects.toThrow(/refused your Tapo login/);
    expect(service.status().lights.find((l) => l.id === OTHER)?.error).toMatch(/refused/);
    store.setChosen(OTHER, false);
  });

  it('finds lights by a loose name, or all of them', () => {
    expect(service.match(undefined).map((l) => l.id)).toEqual([MINE]);
    expect(service.match('all').map((l) => l.id)).toEqual([MINE]);
    expect(service.match('ec750ceaf19f').map((l) => l.id)).toEqual([MINE]);
    expect(service.match('desk')).toEqual([]);
  });
});

describe('what a chat asks for', () => {
  it('turns words into a change, or says why not', () => {
    expect(toChange({ color: 'teal', brightness: 30 })).toEqual({ hue: 175, saturation: 100, brightness: 30 });
    expect(toChange({ on: false })).toEqual({ on: false });
    expect(toChange({ color: 'warm white' })).toEqual({ temp: 2700 });
    expect(toChange({ effect: 'Aurora' })).toEqual({ effect: 'Aurora' });
    expect(toChange({ color: 'banana' })).toMatch(/isn't a colour I know/);
    expect(toChange({})).toMatch(/Say what to change/);
  });
  it('describes a light in a line', () => {
    expect(describeLight({ id: MINE, name: 'L.E.D', reachable: true, on: true, brightness: 40, temp: 2700 })).toBe(
      'L.E.D: on, 40% brightness, white 2700K',
    );
    expect(describeLight({ id: MINE, name: 'L.E.D', reachable: true, on: false })).toBe('L.E.D: off');
    expect(describeLight({ id: MINE, name: 'L.E.D', reachable: false, error: 'No answer.' })).toMatch(/can't be reached/);
  });
});
