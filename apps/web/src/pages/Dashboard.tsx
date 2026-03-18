import { useState, useEffect, useRef } from 'react';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { ConnectionCard } from '../components/dashboard/ConnectionCard';
import { OverviewCards } from '../components/dashboard/OverviewCards';
import { MemoryChart } from '../components/dashboard/MemoryChart';
import { OpsChart } from '../components/dashboard/OpsChart';
import { CpuChart } from '../components/dashboard/CpuChart';
import { IoThreadChart } from '../components/dashboard/IoThreadChart';
import { deriveStoredIoDeltas } from '../components/dashboard/io-threads.utils';
import { EventTimeline } from '../components/dashboard/EventTimeline';
import { CapabilitiesBadges } from '../components/dashboard/CapabilitiesBadges';
import { DateRangePicker, DateRange } from '../components/ui/date-range-picker';
import type { StoredMemorySnapshot } from '../types/metrics';

export function Dashboard() {
  const { currentConnection } = useConnection();

  const { data: health, loading: healthLoading } = usePolling({
    fetcher: metricsApi.getHealth,
    interval: 5000,
    refetchKey: currentConnection?.id,
  });

  const { data: info } = usePolling({
    fetcher: metricsApi.getInfo,
    interval: 5000,
    refetchKey: currentConnection?.id,
  });

  const [memoryHistory, setMemoryHistory] = useState<Array<{ time: string; used: number; peak: number }>>([]);
  const [opsHistory, setOpsHistory] = useState<Array<{ time: string; ops: number }>>([]);
  const [cpuHistory, setCpuHistory] = useState<Array<{ time: string; sys: number; user: number }>>([]);
  const [ioThreadHistory, setIoThreadHistory] = useState<Array<{ time: string; reads: number; writes: number }>>([]);
  const [hasEverSeenIoActivity, setHasEverSeenIoActivity] = useState(false);
  const prevCpuRef = useRef<{ sys: number; user: number; ts: number } | null>(null);
  const prevIoCounters = useRef<{ reads: number; writes: number; ts: number } | null>(null);

  // Time filter state for memory snapshots
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  const startTime = dateRange?.from ? dateRange.from.getTime() : undefined;
  const endTime = dateRange?.to ? dateRange.to.getTime() : undefined;
  const isTimeFiltered = startTime !== undefined && endTime !== undefined;

  const [storedMemorySnapshots, setStoredMemorySnapshots] = useState<StoredMemorySnapshot[] | null>(null);

  useEffect(() => {
    if (!isTimeFiltered) {
      setStoredMemorySnapshots(null);
      return;
    }

    setStoredMemorySnapshots(null);
    let cancelled = false;
    metricsApi.getStoredMemorySnapshots({ startTime, endTime, limit: 500 })
      .then(data => { if (!cancelled) setStoredMemorySnapshots(data); })
      .catch(err => { console.error('Failed to fetch stored memory snapshots:', err); });

    return () => { cancelled = true; };
  }, [startTime, endTime, isTimeFiltered, currentConnection?.id]);

  const sortedStoredSnapshots = storedMemorySnapshots
    ? [...storedMemorySnapshots].sort((a, b) => a.timestamp - b.timestamp)
    : null;

  const formatStoredTime = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString();
  };

  const storedMemoryHistory: Array<{ time: string; used: number; peak: number }> | null = sortedStoredSnapshots
    ? sortedStoredSnapshots.map(s => ({
          time: formatStoredTime(s.timestamp),
          used: s.usedMemory,
          peak: s.usedMemoryPeak,
        }))
    : null;

  const storedOpsHistory: Array<{ time: string; ops: number }> | null = sortedStoredSnapshots
    ? sortedStoredSnapshots.map(s => ({
          time: formatStoredTime(s.timestamp),
          ops: s.opsPerSec ?? 0,
        }))
    : null;

  const storedCpuHistory: Array<{ time: string; sys: number; user: number }> | null = sortedStoredSnapshots
    ? sortedStoredSnapshots.map(s => ({
          time: formatStoredTime(s.timestamp),
          sys: s.cpuSys ?? 0,
          user: s.cpuUser ?? 0,
        }))
    : null;

  const storedIoThreadHistory = sortedStoredSnapshots
    ? deriveStoredIoDeltas(sortedStoredSnapshots, formatStoredTime)
    : null;

  // Clear history when connection changes
  useEffect(() => {
    setMemoryHistory([]);
    setOpsHistory([]);
    setCpuHistory([]);
    setIoThreadHistory([]);
    setHasEverSeenIoActivity(false);
    prevCpuRef.current = null;
    prevIoCounters.current = null;
  }, [currentConnection?.id]);

  useEffect(() => {
    if (!info?.memory || !info?.stats) return;

    const time = new Date().toLocaleTimeString();

    setMemoryHistory((prev) => {
      const next = [...prev, {
        time,
        used: parseInt(info.memory!.used_memory, 10),
        peak: parseInt(info.memory!.used_memory_peak, 10)
      }];
      return next.slice(-60);
    });

    setOpsHistory((prev) => {
      const next = [...prev, { time, ops: parseInt(info.stats!.instantaneous_ops_per_sec, 10) }];
      return next.slice(-60);
    });

    const rawReads = parseInt(info.stats?.io_threaded_reads_processed ?? '0', 10);
    const rawWrites = parseInt(info.stats?.io_threaded_writes_processed ?? '0', 10);

    const ioTs = Date.now();
    if (prevIoCounters.current !== null) {
      const dtSec = (ioTs - prevIoCounters.current.ts) / 1000;
      if (dtSec > 0) {
        const readsPerSec = Math.max(0, (rawReads - prevIoCounters.current.reads) / dtSec);
        const writesPerSec = Math.max(0, (rawWrites - prevIoCounters.current.writes) / dtSec);
        if (readsPerSec > 0 || writesPerSec > 0) {
          setHasEverSeenIoActivity(true);
        }
        setIoThreadHistory(prev => [...prev, {
          time,
          reads: parseFloat(readsPerSec.toFixed(1)),
          writes: parseFloat(writesPerSec.toFixed(1)),
        }].slice(-60));
      }
    }
    prevIoCounters.current = { reads: rawReads, writes: rawWrites, ts: ioTs };

    if (info.cpu) {
      const sys = parseFloat(info.cpu.used_cpu_sys);
      const user = parseFloat(info.cpu.used_cpu_user);
      if (isNaN(sys) || isNaN(user)) return;
      const ts = Date.now();

      const prevCpu = prevCpuRef.current;
      prevCpuRef.current = { sys, user, ts };

      if (prevCpu) {
        const dtSec = (ts - prevCpu.ts) / 1000;
        if (dtSec > 0) {
          const deltaSys = parseFloat((((sys - prevCpu.sys) / dtSec) * 100).toFixed(3));
          const deltaUser = parseFloat((((user - prevCpu.user) / dtSec) * 100).toFixed(3));
          if (deltaSys < 0 || deltaUser < 0) return;
          setCpuHistory((prev) => {
            const next = [...prev, { time, sys: deltaSys, user: deltaUser }];
            return next.slice(-60);
          });
        }
      }
    }
  }, [info]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-4">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <CapabilitiesBadges />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <ConnectionCard health={health} loading={healthLoading} />
        <OverviewCards info={info} />
      </div>

      <EventTimeline startTime={startTime} endTime={endTime} />

      <div className="grid gap-4 lg:grid-cols-2">
        <MemoryChart data={isTimeFiltered ? (storedMemoryHistory ?? []) : memoryHistory} />
        <OpsChart data={isTimeFiltered ? (storedOpsHistory ?? []) : opsHistory} />
        <CpuChart data={isTimeFiltered ? (storedCpuHistory ?? []) : cpuHistory} />
        <IoThreadChart data={isTimeFiltered ? (storedIoThreadHistory ?? []) : ioThreadHistory} isMultiThreaded={info?.server?.io_threads_active === '1'} hasEverSeenActivity={hasEverSeenIoActivity} />
      </div>
    </div>
  );
}
