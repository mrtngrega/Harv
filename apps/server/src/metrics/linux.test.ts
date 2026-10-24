import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseNetDev, readLinuxCpuClock, readLinuxGpu, readLinuxNetwork } from './linux.ts';
import { linuxProgram, withoutOwnHelpers } from './system.ts';

const netDev = (wifiRx: number, wifiTx: number) =>
  [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    `    lo: 35809958    7489    0    0    0     0          0         0 35809958    7489    0    0    0     0       0          0`,
    `wlp1s0: ${wifiRx}  542738    0  311    0     0          0         0 ${wifiTx}   57313    0    4    0     0       0          0`,
    'tailscale0: 1630955    4085    0    0    0     0          0         0  5009272    1810    0    0    0     0       0          0',
    'veth12ab: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0',
  ].join('\n');

describe('Linux network speed (/proc/net/dev)', () => {
  it('reads byte counters, skipping loopback and container interfaces', () => {
    expect([...parseNetDev(netDev(100, 50)).keys()]).toEqual(['wlp1s0', 'tailscale0']);
    expect(parseNetDev(netDev(100, 50)).get('wlp1s0')).toEqual({ rx: 100, tx: 50 });
  });

  it('turns two readings into speeds per second', () => {
    expect(readLinuxNetwork(1000, netDev(1_000_000, 20_000))).toBeUndefined();
    const net = readLinuxNetwork(3000, netDev(3_000_000, 60_000))!;
    expect(net.adapters.find((a) => a.name === 'wlp1s0')).toEqual({ name: 'wlp1s0', downBps: 1_000_000, upBps: 20_000 });
    expect(net.downBps).toBe(1_000_000);
    expect(net.upBps).toBe(20_000);
    // A counter reset (interface came back) never shows as a negative speed.
    expect(readLinuxNetwork(4000, netDev(10, 10))!.downBps).toBe(0);
  });
});

describe('Linux AMD GPU (sysfs)', () => {
  const root = mkdtempSync(join(tmpdir(), 'harv-drm-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads load, temperature, clock and VRAM of an amdgpu card', () => {
    const device = join(root, 'card1', 'device');
    mkdirSync(join(device, 'hwmon', 'hwmon5'), { recursive: true });
    mkdirSync(join(root, 'card1-eDP-1'), { recursive: true });
    writeFileSync(join(device, 'gpu_busy_percent'), '36\n');
    writeFileSync(join(device, 'mem_info_vram_used'), String(256 * 2 ** 20));
    writeFileSync(join(device, 'mem_info_vram_total'), String(512 * 2 ** 20));
    writeFileSync(join(device, 'hwmon', 'hwmon5', 'temp1_input'), '42000');
    writeFileSync(join(device, 'hwmon', 'hwmon5', 'freq1_input'), '675000000');
    expect(readLinuxGpu('Radeon Vega Series', root)).toEqual({
      name: 'Radeon Vega Series',
      load: 36,
      tempC: 42,
      coreClockMhz: 675,
      powerW: undefined,
      vramUsedMb: 256,
      vramTotalMb: 512,
      fanRpm: [],
    });
  });

  it('reports nothing without an AMD GPU', () => {
    expect(readLinuxGpu('x', mkdtempSync(join(tmpdir(), 'harv-nodrm-')))).toBeUndefined();
  });
});

describe('Linux process names', () => {
  it("leaves out Harv's own helpers (sh -c ps)", () => {
    const list = [
      { pid: 10, parentPid: 1, name: 'node' },
      { pid: 11, parentPid: 10, name: 'sh' },
      { pid: 12, parentPid: 11, name: 'ps' },
      { pid: 20, parentPid: 1, name: 'chrome' },
    ];
    expect(withoutOwnHelpers(list, 10).map((p) => p.name)).toEqual(['node', 'chrome']);
  });

  it.runIf(process.platform === 'linux')('takes the program from /proc, not a rewritten command line', () => {
    const me = linuxProgram({ pid: process.pid, name: 'authorize?code=true&client_id=x', path: '/x https://claude.com' });
    expect(me.name).toMatch(/^node/);
    expect(me.path).toBe(process.execPath);
  });

  it("keeps systeminformation's guess for processes it can't read", () => {
    expect(linuxProgram({ pid: -1, name: 'kwin_wayland', path: '/usr/bin' })).toEqual({
      name: 'kwin_wayland',
      path: '/usr/bin/kwin_wayland',
    });
    expect(linuxProgram({ pid: -1, name: 'kworker/0:1', path: '' })).toEqual({ name: 'kworker/0:1', path: '' });
  });
});

describe('Linux CPU clock', () => {
  const root = mkdtempSync(join(tmpdir(), 'harv-cpufreq-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('averages cpufreq, falling back to /proc/cpuinfo', () => {
    for (const [cpu, khz] of [
      ['cpu0', 1600000],
      ['cpu1', 2400000],
    ] as const) {
      mkdirSync(join(root, cpu, 'cpufreq'), { recursive: true });
      writeFileSync(join(root, cpu, 'cpufreq', 'scaling_cur_freq'), `${khz}\n`);
    }
    mkdirSync(join(root, 'cpufreq'));
    expect(readLinuxCpuClock(root)).toBe(2000);
    const cpuinfo = () => 'processor\t: 0\ncpu MHz\t\t: 1693.5\nprocessor\t: 1\ncpu MHz\t\t: 2306.5\n';
    expect(readLinuxCpuClock(join(root, 'missing'), cpuinfo)).toBe(2000);
    expect(readLinuxCpuClock(join(root, 'missing'), () => undefined)).toBeUndefined();
  });
});
