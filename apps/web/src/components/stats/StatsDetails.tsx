import type { MetricsSnapshot } from '@harv/shared';
import { celsius, countDuplicates, duration, gb, ghz, pct, rate, sizePair, watts } from '../../lib/format.ts';
import { BarList, Card, Rows, ThreadBars } from './parts.tsx';

const shortCpu = (name: string) => name.replace(/^AMD |^Intel\(R\) Core\(TM\) /, '').replace(/ \d+-Core Processor$/, '');
const shortGpu = (name: string) => name.replace(/^NVIDIA GeForce |^AMD Radeon /, '');

/** "38% · 377 / 377 rpm", or whichever half is available. */
function gpuFans(fanPct: number | undefined, rpm: number[]): string | undefined {
  const parts = [fanPct !== undefined ? pct(fanPct) : '', rpm.length ? `${rpm.map(Math.round).join(' / ')} rpm` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

export function StatsDetails({ m }: { m: MetricsSnapshot }) {
  const { cpu, gpu, memory, network, cooling } = m;

  return (
    <>
      {!m.sources.lhm && (
        <p className="m-0 rounded-xl border border-warn/40 bg-black/20 p-3 text-xs leading-relaxed text-muted">
          LibreHardwareMonitor isn't running, so temperatures, fans, power and drive health are hidden. Start it to see everything.
        </p>
      )}

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

      <div className="mt-1 border-t border-line px-1 pt-2.5 text-[11px] tracking-[2px] text-muted">CLAUDE PLAN</div>
      <Card title="Usage" sub="session · weekly">
        <p className="m-0 text-xs text-muted">Plan usage arrives in M7.</p>
      </Card>
    </>
  );
}
