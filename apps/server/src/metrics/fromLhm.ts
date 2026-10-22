import type { CoolingMetrics, DriveMetrics, GpuMetrics, NetworkMetrics } from '@harv/shared';
import { byteMultiplier, type LhmSensor } from './lhm.ts';

/** The subset of a snapshot that LibreHardwareMonitor can provide. */
export interface LhmReadings {
  cpu?: { name: string; load: number; perThread: number[]; clockMhz?: number; tempC?: number; powerW?: number };
  gpu?: GpuMetrics;
  memory?: { load: number; usedBytes: number; availableBytes: number; committedBytes?: number; modules: string[] };
  drives: DriveMetrics[];
  network?: NetworkMetrics;
  cooling?: CoolingMetrics;
}

const GB = 1024 ** 3;

function groupByHardware(sensors: LhmSensor[]): Map<string, LhmSensor[]> {
  const groups = new Map<string, LhmSensor[]>();
  for (const s of sensors) {
    const list = groups.get(s.hardwareId) ?? [];
    list.push(s);
    groups.set(s.hardwareId, list);
  }
  return groups;
}

function pick(list: LhmSensor[], type: string, name: string | RegExp): LhmSensor | undefined {
  return list.find((s) => s.type === type && (typeof name === 'string' ? s.name === name : name.test(s.name)));
}

const val = (s: LhmSensor | undefined) => s?.value;
const bytes = (s: LhmSensor | undefined) => (s ? s.value * byteMultiplier(s.unit) : undefined);
const threadNo = (s: LhmSensor) => Number(/#(\d+)/.exec(s.name)?.[1] ?? 0);

export function readingsFromLhm(sensors: LhmSensor[]): LhmReadings {
  const groups = groupByHardware(sensors);
  const hw = (prefix: RegExp) => [...groups.entries()].filter(([id]) => prefix.test(id));
  const out: LhmReadings = { drives: [] };

  const cpuEntry = hw(/^\/(amdcpu|intelcpu)\//)[0];
  if (cpuEntry) {
    const list = cpuEntry[1];
    const perThread = list
      .filter((s) => s.type === 'Load' && /^CPU Core #\d+$/.test(s.name))
      .sort((a, b) => threadNo(a) - threadNo(b))
      .map((s) => s.value);
    out.cpu = {
      name: list[0]!.hardwareName,
      load: val(pick(list, 'Load', 'CPU Total')) ?? 0,
      perThread,
      clockMhz: val(pick(list, 'Clock', 'Cores (Average)')),
      tempC: val(pick(list, 'Temperature', /Tctl|Package|CPU Package|Core \(Tctl/)),
      powerW: val(pick(list, 'Power', /^(Package|CPU Package)$/)),
    };
  }

  const gpuEntry = hw(/^\/gpu-(nvidia|amd|intel)\//)[0];
  if (gpuEntry) {
    const list = gpuEntry[1];
    out.gpu = {
      name: list[0]!.hardwareName,
      load: val(pick(list, 'Load', 'GPU Core')) ?? 0,
      tempC: val(pick(list, 'Temperature', 'GPU Core')),
      hotspotC: val(pick(list, 'Temperature', 'GPU Hot Spot')),
      vramUsedMb: val(pick(list, 'SmallData', 'GPU Memory Used')),
      vramTotalMb: val(pick(list, 'SmallData', 'GPU Memory Total')),
      powerW: val(pick(list, 'Power', /^GPU (Package|Power)$/)),
      coreClockMhz: val(pick(list, 'Clock', 'GPU Core')),
      memClockMhz: val(pick(list, 'Clock', 'GPU Memory')),
      fanPct: val(pick(list, 'Control', /^GPU Fan/)),
      fanRpm: list.filter((s) => s.type === 'Fan').map((s) => s.value),
    };
  }

  const ram = groups.get('/ram');
  if (ram) {
    const used = bytes(pick(ram, 'Data', 'Memory Used')) ?? 0;
    const available = bytes(pick(ram, 'Data', 'Memory Available')) ?? 0;
    const modules = hw(/^\/memory\/dimm\//).map(([, list]) => {
      const size = bytes(pick(list, 'Data', 'Capacity'));
      const name = list[0]!.hardwareName.replace(/\s*\(#\d+\)$/, '');
      return `${name}${size ? ` · ${Math.round(size / GB)} GB` : ''}`;
    });
    out.memory = {
      load: val(pick(ram, 'Load', 'Memory')) ?? 0,
      usedBytes: used,
      availableBytes: available,
      committedBytes: bytes(pick(groups.get('/vram') ?? [], 'Data', 'Memory Used')),
      modules,
    };
  }

  for (const [, list] of hw(/^\/(nvme|hdd|ssd)\//)) {
    out.drives.push({
      name: list[0]!.hardwareName,
      tempC: val(pick(list, 'Temperature', /^(Composite Temperature|Temperature)$/)),
      lifePct: val(pick(list, 'Level', 'Life')),
      usedPct: val(pick(list, 'Load', 'Used Space')),
      activityPct: val(pick(list, 'Load', 'Total Activity')),
      readBps: bytes(pick(list, 'Throughput', 'Read Rate')),
      writeBps: bytes(pick(list, 'Throughput', 'Write Rate')),
    });
  }

  const nics = hw(/^\/nic\//).map(([, list]) => ({
    name: list[0]!.hardwareName,
    downBps: bytes(pick(list, 'Throughput', 'Download Speed')) ?? 0,
    upBps: bytes(pick(list, 'Throughput', 'Upload Speed')) ?? 0,
    utilization: val(pick(list, 'Load', 'Network Utilization')),
    // Adapters that have never moved data (unused virtual adapters) are hidden.
    used: (val(pick(list, 'Data', 'Data Downloaded')) ?? 0) + (val(pick(list, 'Data', 'Data Uploaded')) ?? 0) > 0,
  }));
  if (nics.length > 0) {
    const adapters = nics.filter((n) => n.used || n.downBps + n.upBps > 0).map(({ used: _used, ...n }) => n);
    out.network = {
      downBps: nics.reduce((sum, n) => sum + n.downBps, 0),
      upBps: nics.reduce((sum, n) => sum + n.upBps, 0),
      utilization: Math.max(0, ...nics.map((n) => n.utilization ?? 0)),
      adapters,
    };
  }

  const board = hw(/^\/lpc\//).flatMap(([, list]) => list);
  const fans = [
    ...board.filter((s) => s.type === 'Fan' && s.value > 0).map((s) => ({ name: s.name, value: s.value })),
    ...(gpuEntry?.[1] ?? []).filter((s) => s.type === 'Fan').map((s) => ({ name: s.name, value: s.value })),
  ];
  // Unconnected header sensors report nonsense (e.g. 9 °C), so keep plausible readings only.
  const boardTempsC = board
    .filter((s) => s.type === 'Temperature' && s.value >= 15 && s.value <= 110)
    .map((s) => ({ name: s.name, value: s.value }));
  if (fans.length || boardTempsC.length) out.cooling = { fans, boardTempsC };

  return out;
}
