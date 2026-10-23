import { useState } from 'react';
import type { LhmLaunchResult, MetricsSnapshot } from '@harv/shared';
import { celsius, countDuplicates, duration, gb, ghz, pct, rate, sizePair, watts } from '../../lib/format.ts';
import { ActionLog } from './ActionLog.tsx';
import { BarList, Card, Rows, ThreadBars } from './parts.tsx';

const shortCpu = (name: string) => name.replace(/^AMD |^Intel\(R\) Core\(TM\) /, '').replace(/ \d+-Core Processor$/, '');
const shortGpu = (name: string) => name.replace(/^NVIDIA GeForce |^AMD Radeon /, '');

/** "38% · 377 / 377 rpm", or whichever half is available. */
function gpuFans(fanPct: number | undefined, rpm: number[]): string | undefined {
  const parts = [fanPct !== undefined ? pct(fanPct) : '', rpm.length ? `${rpm.map(Math.round).join(' / ')} rpm` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

const LAUNCH_MESSAGES: Record<LhmLaunchResult, string> = {
  'already-running': 'LibreHardwareMonitor is running; sensors will appear in a moment.',
  started: 'Started. Sensors will appear in a moment.',
  declined: 'The Windows prompt was declined. Click again and choose Yes.',
  'not-installed': 'LibreHardwareMonitor isn’t installed (winget install LibreHardwareMonitor.LibreHardwareMonitor).',
  failed: 'Couldn’t start LibreHardwareMonitor. Check the server log.',
};

function SensorsOffline() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/sensors/start', { method: 'POST' });
      const { result } = (await res.json()) as { result: LhmLaunchResult };
      setMessage(LAUNCH_MESSAGES[result]);
    } catch {
      setMessage(LAUNCH_MESSAGES.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-black/20 p-3 text-xs leading-relaxed text-muted">
      <p className="m-0">LibreHardwareMonitor isn't running, so temperatures, fans, power and drive health are hidden.</p>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="min-h-9 cursor-pointer self-start rounded-lg border border-line bg-white/5 px-3 text-ink hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? 'Waiting for Windows prompt…' : 'Start sensors'}
      </button>
      {message && <p className="m-0 text-ink">{message}</p>}
    </div>
  );
}

export function StatsDetails({ m }: { m: MetricsSnapshot }) {
  const { cpu, gpu, memory, network, cooling } = m;

  return (
    <>
      {!m.sources.lhm && <SensorsOffline />}

      <Card title="CPU" sub={`${shortCpu(cpu.name)} · ${cpu.cores}C/${cpu.threads}T`} value={pct(cpu.load)} load={cpu.load}>
        {cpu.perThread.length > 0 && <ThreadBars loads={cpu.perThread} />}
        <Rows
          rows={[
            ['Clock', ghz(cpu.clockMhz)],
            ['Temp', celsius(cpu.tempC)],
            ['Power', watts(cpu.powerW)],
            ['Peak temp', celsius(cpu.peakTempC)],
          ]}
        />
        <BarList title="Top processes" items={cpu.topByCpu.map((p) => ({ name: p.name, value: `${p.cpu.toFixed(1)}%`, share: p.cpu }))} />
      </Card>

      {gpu && (
        <Card title="GPU" sub={shortGpu(gpu.name)} value={pct(gpu.load)} load={gpu.load}>
          <Rows
            rows={[
              ['Temp', celsius(gpu.tempC)],
              ['Hotspot', celsius(gpu.hotspotC)],
              [
                'VRAM',
                gpu.vramUsedMb !== undefined && gpu.vramTotalMb !== undefined
                  ? `${(gpu.vramUsedMb / 1024).toFixed(1)} / ${(gpu.vramTotalMb / 1024).toFixed(0)} GB`
                  : undefined,
              ],
              ['Power', watts(gpu.powerW)],
              ['Core clock', ghz(gpu.coreClockMhz)],
              ['Mem clock', ghz(gpu.memClockMhz)],
              ['Fans', gpuFans(gpu.fanPct, gpu.fanRpm)],
            ]}
          />
        </Card>
      )}

      <Card title="Memory" sub={gb(memory.totalBytes, 0)} value={pct(memory.load)} load={memory.load}>
        <Rows
          rows={[
            ['Used', gb(memory.usedBytes)],
            ['Available', gb(memory.availableBytes)],
            ['Committed', memory.committedBytes ? gb(memory.committedBytes) : undefined],
          ]}
        />
        {memory.modules.length > 0 && (
          <div className="text-[11px] leading-relaxed text-muted">{countDuplicates(memory.modules).join(' · ')}</div>
        )}
        <BarList
          title="Top processes"
          items={memory.topByMem.map((p) => ({ name: p.name, value: gb(p.memBytes), share: (p.memBytes / memory.totalBytes) * 100 }))}
        />
      </Card>

      {(m.volumes.length > 0 || m.drives.length > 0) && (
        <Card title="Storage" sub={`${m.volumes.length} volumes · ${m.drives.length} drives`}>
          <BarList
            title="Volumes"
            items={m.volumes.map((v) => ({ name: v.mount, value: sizePair(v.usedBytes, v.totalBytes), share: v.load }))}
          />
          {m.drives.map((d) => (
            <div key={d.name + d.tempC} className="flex flex-col gap-1">
              <div className="truncate text-[11px] text-muted">{d.name}</div>
              <Rows
                rows={[
                  ['Temp', celsius(d.tempC)],
                  ['Life', pct(d.lifePct)],
                  ['Read', d.readBps !== undefined ? rate(d.readBps) : undefined],
                  ['Write', d.writeBps !== undefined ? rate(d.writeBps) : undefined],
                ]}
              />
            </div>
          ))}
        </Card>
      )}

      {network && (
        <Card
          title="Network"
          sub={network.adapters.map((a) => a.name).join(' · ')}
          value={rate(network.downBps)}
          load={network.utilization}
        >
          <Rows
            rows={[
              ['Down', rate(network.downBps)],
              ['Up', rate(network.upBps)],
            ]}
          />
        </Card>
      )}

      {cooling && (
        <Card title="Cooling" sub="fans & board" value={`${cooling.fans.length} fans`}>
          <Rows
            rows={[
              ...cooling.fans.map((f): [string, string] => [f.name, `${Math.round(f.value)} rpm`]),
              ...cooling.boardTempsC.map((t): [string, string] => [t.name.replace('Temperature', 'Board'), celsius(t.value)]),
              ['Uptime', duration(m.uptimeSec)],
            ]}
          />
        </Card>
      )}

      <div className="mt-1 border-t border-line px-1 pt-2.5 text-[11px] tracking-[2px] text-muted">HARV</div>
      <ActionLog />
    </>
  );
}
