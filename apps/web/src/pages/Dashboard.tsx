import { useState, useEffect, useRef } from 'react';
import { metricsApi } from '../api/metrics';
import { usePolling } from '../hooks/usePolling';
import { useConnection } from '../hooks/useConnection';
import { ConnectionCard } from '../components/dashboard/ConnectionCard';
import { OverviewCards } from '../components/dashboard/OverviewCards';
import { MemoryChart } from '../components/dashboard/MemoryChart';
import { OpsChart } from '../components/dashboard/OpsChart';
import { CpuChart } from '../components/dashboard/CpuChart';
import { CapabilitiesBadges } from '../components/dashboard/CapabilitiesBadges';
import { DoctorCard } from '../components/DoctorCard';
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
  const prevCpuRef = useRef<{ sys: number; user: number; ts: number } | null>(null);
  const [memoryDoctorReport, setMemoryDoctorReport] = useState<string>();
  const [memoryDoctorLoading, setMemoryDoctorLoading] = useState(true);

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

    let cancelled = false;
    metricsApi.getStoredMemorySnapshots({ startTime, endTime, limit: 500 })
      .then(data => { if (!cancelled) setStoredMemorySnapshots(data); })
      .catch(err => { console.error('Failed to fetch stored memory snapshots:', err); });

    return () => { cancelled = true; };
  }, [startTime, endTime, isTimeFiltered]);

  const storedMemoryHistory: Array<{ time: string; used: number; peak: number }> | null = storedMemorySnapshots
    ? [...storedMemorySnapshots]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(s => ({
          time: new Date(s.timestamp).toLocaleTimeString(),
          used: s.usedMemory,
          peak: s.usedMemoryPeak,
        }))
    : null;

  // Clear history when connection changes
  useEffect(() => {
    setMemoryHistory([]);
    setOpsHistory([]);
    setCpuHistory([]);
    prevCpuRef.current = null;
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

  useEffect(() => {
    setMemoryDoctorLoading(true);
    metricsApi.getMemoryDoctor()
      .then(data => setMemoryDoctorReport(data.report))
      .catch(console.error)
      .finally(() => setMemoryDoctorLoading(false));
  }, [currentConnection?.id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-4">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <CapabilitiesBadges />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <ConnectionCard health={health} loading={healthLoading} />
        <OverviewCards info={info} />
      </div>

      <DoctorCard
        title="Memory Doctor"
        report={memoryDoctorReport}
        isLoading={memoryDoctorLoading}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <MemoryChart data={isTimeFiltered ? (storedMemoryHistory ?? []) : memoryHistory} />
        <OpsChart data={opsHistory} />
        <CpuChart data={cpuHistory} />
      </div>
    </div>
  );
}
