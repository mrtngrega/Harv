/** One process in a "top processes" list (grouped by executable name). */
export interface ProcessUsage {
  name: string;
  /** Share of total CPU, 0–100. */
  cpu: number;
  memBytes: number;
}

export interface CpuMetrics {
  name: string;
  cores: number;
  threads: number;
  load: number;
  perThread: number[];
  clockMhz?: number;
  tempC?: number;
  /** Highest temperature seen since Harv started. */
  peakTempC?: number;
  powerW?: number;
  topByCpu: ProcessUsage[];
}

export interface GpuMetrics {
  name: string;
  load: number;
  tempC?: number;
  hotspotC?: number;
  vramUsedMb?: number;
  vramTotalMb?: number;
  powerW?: number;
  coreClockMhz?: number;
  memClockMhz?: number;
  fanPct?: number;
  fanRpm: number[];
}

export interface MemoryMetrics {
  load: number;
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  /** Committed memory (RAM + page file in use). */
  committedBytes?: number;
  modules: string[];
  topByMem: ProcessUsage[];
}

/** A drive letter as Windows sees it. */
export interface VolumeMetrics {
  mount: string;
  usedBytes: number;
  totalBytes: number;
  load: number;
}

/** A physical disk with health sensors. */
export interface DriveMetrics {
  name: string;
  tempC?: number;
  lifePct?: number;
  usedPct?: number;
  activityPct?: number;
  readBps?: number;
  writeBps?: number;
}

export interface NetworkAdapterMetrics {
  name: string;
  downBps: number;
  upBps: number;
  utilization?: number;
}

export interface NetworkMetrics {
  downBps: number;
  upBps: number;
  /** Utilization of the busiest adapter, 0–100. */
  utilization?: number;
  adapters: NetworkAdapterMetrics[];
}

export interface NamedReading {
  name: string;
  value: number;
}

export interface CoolingMetrics {
  fans: NamedReading[];
  boardTempsC: NamedReading[];
}

export interface MetricsSnapshot {
  at: number;
  uptimeSec: number;
  cpu: CpuMetrics;
  gpu?: GpuMetrics;
  memory: MemoryMetrics;
  volumes: VolumeMetrics[];
  drives: DriveMetrics[];
  network?: NetworkMetrics;
  cooling?: CoolingMetrics;
  /** Which sensor sources answered; the dashboard hides what's missing. */
  sources: { lhm: boolean; nvidiaSmi: boolean };
}
