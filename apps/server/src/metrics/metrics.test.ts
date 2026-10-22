import { describe, expect, it } from 'vitest';
import { readingsFromLhm } from './fromLhm.ts';
import { byteMultiplier, flattenLhm, parseLhmValue, type LhmNode } from './lhm.ts';
import { parseNvidiaSmi } from './nvidia.ts';
import { topProcesses } from './system.ts';

const sensor = (Text: string, Type: string, Value: string, SensorId: string): LhmNode => ({ Text, Type, Value, SensorId });
const hardware = (Text: string, HardwareId: string, groups: Record<string, LhmNode[]>): LhmNode => ({
  Text,
  HardwareId,
  Children: Object.entries(groups).map(([group, Children]) => ({ Text: group, Children })),
});

// A trimmed, synthetic LHM tree in the same shape as data.json (comma decimals, as on a Slovak/German locale).
const TREE: LhmNode = {
  Text: 'Sensor',
  Children: [
    {
      Text: 'PC',
      Children: [
        {
          Text: 'Test Board',
          HardwareId: '/motherboard',
          Children: [
            hardware('Nuvoton Test', '/lpc/test/0', {
              Temperatures: [
                sensor('Temperature #1', 'Temperature', '38,5 °C', '/lpc/test/0/temperature/1'),
                sensor('Temperature #3', 'Temperature', '9,5 °C', '/lpc/test/0/temperature/3'),
              ],
              Fans: [sensor('Fan #1', 'Fan', '702 RPM', '/lpc/test/0/fan/0'), sensor('Fan #3', 'Fan', '0 RPM', '/lpc/test/0/fan/2')],
            }),
          ],
        },
        hardware('Test CPU', '/amdcpu/0', {
          Load: [
            sensor('CPU Total', 'Load', '3,7 %', '/amdcpu/0/load/0'),
            sensor('CPU Core #2', 'Load', '9,4 %', '/amdcpu/0/load/3'),
            sensor('CPU Core #1', 'Load', '4,7 %', '/amdcpu/0/load/2'),
          ],
          Temperatures: [sensor('Core (Tctl/Tdie)', 'Temperature', '50,1 °C', '/amdcpu/0/temperature/2')],
          Powers: [sensor('Package', 'Power', '31,9 W', '/amdcpu/0/power/0')],
          Clocks: [sensor('Cores (Average)', 'Clock', '3348,0 MHz', '/amdcpu/0/clock/1')],
        }),
        hardware('Total Memory', '/ram', {
          Load: [sensor('Memory', 'Load', '41,6 %', '/ram/load/0')],
          Data: [sensor('Memory Used', 'Data', '13,3 GB', '/ram/data/0'), sensor('Memory Available', 'Data', '18,7 GB', '/ram/data/1')],
        }),
        hardware('Test GPU', '/gpu-nvidia/0', {
          Load: [sensor('GPU Core', 'Load', '3,0 %', '/gpu-nvidia/0/load/0')],
          Temperatures: [
            sensor('GPU Core', 'Temperature', '55,0 °C', '/gpu-nvidia/0/temperature/0'),
            sensor('GPU Hot Spot', 'Temperature', '66,9 °C', '/gpu-nvidia/0/temperature/2'),
          ],
          Fans: [sensor('GPU Fan 1', 'Fan', '378 RPM', '/gpu-nvidia/0/fan/1')],
          Data: [
            sensor('GPU Memory Used', 'SmallData', '1590,0 MB', '/gpu-nvidia/0/smalldata/1'),
            sensor('GPU Memory Total', 'SmallData', '8192,0 MB', '/gpu-nvidia/0/smalldata/2'),
          ],
        }),
        hardware('Test NVMe', '/nvme/0', {
          Temperatures: [sensor('Composite Temperature', 'Temperature', '43,0 °C', '/nvme/0/temperature/0')],
          Levels: [sensor('Life', 'Level', '99,0 %', '/nvme/0/level/20')],
          Throughput: [sensor('Read Rate', 'Throughput', '16,0 KB/s', '/nvme/0/throughput/54')],
        }),
        hardware('Ethernet', '/nic/eth', {
          Data: [sensor('Data Downloaded', 'Data', '3,0 GB', '/nic/eth/data/3')],
          Throughput: [
            sensor('Download Speed', 'Throughput', '1,5 MB/s', '/nic/eth/throughput/8'),
            sensor('Upload Speed', 'Throughput', '17,7 KB/s', '/nic/eth/throughput/7'),
          ],
        }),
        hardware('Unused VPN', '/nic/vpn', {
          Data: [sensor('Data Downloaded', 'Data', '0,0 GB', '/nic/vpn/data/3')],
          Throughput: [sensor('Download Speed', 'Throughput', '0,0 KB/s', '/nic/vpn/throughput/8')],
        }),
      ],
    },
  ],
};

describe('parseLhmValue', () => {
  it.each([
    ['38,5 °C', 38.5, '°C'],
    ['1,6 MB/s', 1.6, 'MB/s'],
    ['3348,0 MHz', 3348, 'MHz'],
    ['1.234,5 GB', 1234.5, 'GB'],
    ['1,234.5 GB', 1234.5, 'GB'],
    ['702 RPM', 702, 'RPM'],
    ['0,856 V', 0.856, 'V'],
  ])('parses %s', (raw, value, unit) => {
    expect(parseLhmValue(raw)).toEqual({ value, unit });
  });

  it('rejects non-numeric values', () => {
    expect(parseLhmValue('Value')).toBeNull();
  });

  it('knows byte units', () => {
    expect(byteMultiplier('KB/s')).toBe(1024);
    expect(byteMultiplier('°C')).toBe(1);
  });
});

describe('readingsFromLhm', () => {
  const r = readingsFromLhm(flattenLhm(TREE));

  it('reads the CPU with threads in order', () => {
    expect(r.cpu).toMatchObject({ name: 'Test CPU', load: 3.7, perThread: [4.7, 9.4], tempC: 50.1, powerW: 31.9, clockMhz: 3348 });
  });

  it('reads the GPU', () => {
    expect(r.gpu).toMatchObject({ load: 3, tempC: 55, hotspotC: 66.9, vramUsedMb: 1590, vramTotalMb: 8192, fanRpm: [378] });
  });

  it('converts memory to bytes', () => {
    expect(r.memory!.usedBytes).toBeCloseTo(13.3 * 1024 ** 3);
    expect(r.memory!.load).toBe(41.6);
  });

  it('reads drive health and throughput', () => {
    expect(r.drives).toEqual([expect.objectContaining({ name: 'Test NVMe', tempC: 43, lifePct: 99, readBps: 16 * 1024 })]);
  });

  it('sums network speed and hides adapters that never moved data', () => {
    expect(r.network!.downBps).toBeCloseTo(1.5 * 1024 ** 2);
    expect(r.network!.adapters.map((a) => a.name)).toEqual(['Ethernet']);
  });

  it('keeps spinning fans and plausible board temperatures only', () => {
    expect(r.cooling!.fans.map((f) => f.name)).toEqual(['Fan #1', 'GPU Fan 1']);
    expect(r.cooling!.boardTempsC).toEqual([{ name: 'Temperature #1', value: 38.5 }]);
  });
});

describe('topProcesses', () => {
  it('groups by name, skips idle and converts KB to bytes', () => {
    const top = topProcesses([
      { name: 'System Idle Process', cpu: 90, memRss: 8 },
      { name: 'chrome.exe', cpu: 3, memRss: 1000 },
      { name: 'chrome.exe', cpu: 2, memRss: 3000 },
      { name: 'code.exe', cpu: 4, memRss: 500 },
    ]);
    expect(top.byCpu.map((p) => [p.name, p.cpu])).toEqual([
      ['chrome.exe', 5],
      ['code.exe', 4],
    ]);
    expect(top.byMem[0]).toEqual({ name: 'chrome.exe', cpu: 5, memBytes: 4000 * 1024 });
  });
});

describe('parseNvidiaSmi', () => {
  it('parses a CSV line', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, 41, 63, 1590, 8192, 58.30, 1800, 7501, 38')).toMatchObject({
      name: 'NVIDIA GeForce RTX 3060 Ti',
      load: 41,
      tempC: 63,
      powerW: 58.3,
      fanPct: 38,
    });
  });

  it('treats [N/A] as missing', () => {
    expect(parseNvidiaSmi('GPU, 1, 2, 3, 4, [N/A], 5, 6, [N/A]')).toMatchObject({ powerW: undefined, fanPct: undefined });
  });
});
