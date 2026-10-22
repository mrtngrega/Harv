// Reads LibreHardwareMonitor's web server (http://127.0.0.1:8085/data.json).
// LHM formats values for the Windows locale ("38,5 °C", "1,6 MB/s"), so they're parsed here.

export const LHM_URL = process.env.HARV_LHM_URL ?? 'http://127.0.0.1:8085/data.json';

export interface LhmNode {
  Text: string;
  Value?: string;
  SensorId?: string;
  HardwareId?: string;
  Type?: string;
  Children?: LhmNode[];
}

export interface LhmSensor {
  id: string;
  hardwareId: string;
  hardwareName: string;
  type: string;
  name: string;
  value: number;
  unit: string;
}

/** Parses a locale-formatted LHM value: "38,5 °C" → { value: 38.5, unit: "°C" }. */
export function parseLhmValue(raw: string): { value: number; unit: string } | null {
  // \s also matches the non-breaking spaces some locales use as thousands separators.
  const match = /^\s*(-?[\d\s.,]*\d)\s*(.*)$/.exec(raw);
  if (!match) return null;
  let num = match[1]!.replace(/\s/g, '');
  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');
  if (lastComma > lastDot) {
    // Comma is the decimal separator; dots (if any) group thousands.
    num = num.replace(/\./g, '').replace(',', '.');
  } else {
    num = num.replace(/,/g, '');
  }
  const value = Number(num);
  return Number.isFinite(value) ? { value, unit: match[2]!.trim() } : null;
}

const BYTE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Converts "KB/s", "MB", "GB" etc. to a byte multiplier (1 when the unit isn't a byte unit). */
export function byteMultiplier(unit: string): number {
  return BYTE_UNITS[unit.replace('/s', '')] ?? 1;
}

/** Flattens LHM's nested tree into sensors tagged with their hardware. */
export function flattenLhm(root: LhmNode): LhmSensor[] {
  const sensors: LhmSensor[] = [];
  const walk = (node: LhmNode, hardwareId: string, hardwareName: string) => {
    if (node.HardwareId) {
      hardwareId = node.HardwareId;
      hardwareName = node.Text.replace(/\s+/g, ' ').trim();
    }
    if (node.SensorId && node.Type && node.Value) {
      const parsed = parseLhmValue(node.Value);
      if (parsed) {
        sensors.push({ id: node.SensorId, hardwareId, hardwareName, type: node.Type, name: node.Text.trim(), ...parsed });
      }
    }
    for (const child of node.Children ?? []) walk(child, hardwareId, hardwareName);
  };
  walk(root, '', '');
  return sensors;
}

export async function fetchLhm(signal?: AbortSignal): Promise<LhmSensor[] | null> {
  try {
    const res = await fetch(LHM_URL, { signal: signal ?? AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return flattenLhm((await res.json()) as LhmNode);
  } catch {
    return null;
  }
}
