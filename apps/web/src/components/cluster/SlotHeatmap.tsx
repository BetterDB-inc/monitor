import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Info } from 'lucide-react';
import type { SlotStats, ClusterNode } from '../../types/metrics';
import { buildSlotNodeMap, CLUSTER_TOTAL_SLOTS, CLUSTER_GRID_SIZE } from '../../types/cluster';

interface SlotHeatmapProps {
  slotStats: SlotStats | null;
  nodes: ClusterNode[];
  hasSlotStats: boolean;
}

export function SlotHeatmap({ slotStats, nodes, hasSlotStats }: SlotHeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredSlot, setHoveredSlot] = useState<{
    slot: number;
    x: number;
    y: number;
    keyCount: number;
    nodeId: string;
  } | null>(null);

  // Memoize slot-to-node mapping (expensive to rebuild on every render)
  const slotNodeMap = useMemo(() => buildSlotNodeMap(nodes), [nodes]);

  // Memoize drawHeatmap function with proper dependencies
  const drawHeatmap = useCallback(() => {
    if (!hasSlotStats || !slotStats || !canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get container dimensions and make canvas square based on width
    const containerWidth = container.clientWidth;
    const canvasSize = Math.min(containerWidth, 800); // Max 800px

    // Set canvas pixel dimensions (actual resolution)
    const pixelRatio = window.devicePixelRatio || 1;
    const pixelSize = canvasSize * pixelRatio;
    canvas.width = pixelSize;
    canvas.height = pixelSize;

    // Set canvas display size (CSS)
    canvas.style.width = `${canvasSize}px`;
    canvas.style.height = `${canvasSize}px`;

    // Scale context to account for device pixel ratio
    ctx.scale(pixelRatio, pixelRatio);

    // Resolve CSS variable to RGB by forcing the browser to serialize as rgb()
    const rootStyles = getComputedStyle(document.documentElement);

    function resolveToRgb(cssVar: string, fallback: [number, number, number]): [number, number, number] {
      const raw = rootStyles.getPropertyValue(cssVar).trim();
      if (!raw) return fallback;
      const el = document.createElement('div');
      el.style.color = raw;
      document.body.appendChild(el);
      const resolved = getComputedStyle(el).color;
      document.body.removeChild(el);
      // Match rgb(r, g, b) or rgba(r, g, b, a) — only capture the 3 color channels
      const match = resolved.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : fallback;
    }

    const [r, g, b] = resolveToRgb('--primary', [20, 184, 166]);
    const [mr, mg, mb] = resolveToRgb('--muted', [243, 244, 246]);
    const mutedColor = `rgb(${mr}, ${mg}, ${mb})`;

    // Find max key count for normalization
    const maxKeys = Math.max(
      ...Object.values(slotStats).map((s) => s.key_count),
      1
    );

    // Calculate cell size in display pixels
    const cellSize = canvasSize / CLUSTER_GRID_SIZE;

    // Draw each slot
    for (let slot = 0; slot < CLUSTER_TOTAL_SLOTS; slot++) {
      const x = (slot % CLUSTER_GRID_SIZE) * cellSize;
      const y = Math.floor(slot / CLUSTER_GRID_SIZE) * cellSize;
      const stats = slotStats[slot.toString()];

      if (stats && stats.key_count > 0) {
        // Normalize intensity (0.1 to 1.0 range for visibility)
        const intensity = 0.1 + (stats.key_count / maxKeys) * 0.9;
        // Primary color scale
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${intensity})`;
      } else {
        // Muted for empty slots
        ctx.fillStyle = mutedColor;
      }

      // Draw cell with small gap for visibility
      const gap = cellSize > 2 ? 0.5 : 0;
      ctx.fillRect(x, y, cellSize - gap, cellSize - gap);
    }
  }, [hasSlotStats, slotStats]);

  // Draw on mount and when data changes
  useEffect(() => {
    drawHeatmap();
  }, [drawHeatmap]);

  // Redraw on window resize
  useEffect(() => {
    const handleResize = () => {
      drawHeatmap();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawHeatmap]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasSlotStats || !slotStats || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Calculate slot from position based on actual canvas size
    const cellX = Math.floor((x / rect.width) * CLUSTER_GRID_SIZE);
    const cellY = Math.floor((y / rect.height) * CLUSTER_GRID_SIZE);
    const slot = cellY * CLUSTER_GRID_SIZE + cellX;

    if (slot >= 0 && slot < CLUSTER_TOTAL_SLOTS) {
      const stats = slotStats[slot.toString()];
      const nodeId = slotNodeMap.get(slot) || 'unknown';

      setHoveredSlot({
        slot,
        x: e.clientX,
        y: e.clientY,
        keyCount: stats?.key_count || 0,
        nodeId,
      });
    }
  };

  const handleMouseLeave = () => {
    setHoveredSlot(null);
  };

  if (!hasSlotStats) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Slot Heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Info className="w-12 h-12 text-muted-foreground mb-3 opacity-50" />
            <p className="text-muted-foreground font-medium">
              Slot statistics not available
            </p>
            <p className="text-sm text-muted-foreground mt-2 max-w-md">
              This feature requires Valkey 8.0+ or Redis with CLUSTER SLOT-STATS support.
              Connect to a compatible cluster to view per-slot key distribution.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Slot Heatmap</CardTitle>
        <p className="text-sm text-muted-foreground mt-1">
          Key distribution across 16,384 hash slots
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Canvas */}
          <div ref={containerRef} className="relative w-full">
            <canvas
              ref={canvasRef}
              className="border rounded w-full"
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: 'crosshair', aspectRatio: '1/1' }}
              role="img"
              aria-label={
                slotStats
                  ? `Cluster slot heatmap showing key distribution across ${Object.values(slotStats).filter((s) => s.key_count > 0).length} populated slots out of ${CLUSTER_TOTAL_SLOTS} total slots`
                  : 'Cluster slot heatmap'
              }
            />

            {/* Tooltip */}
            {hoveredSlot && (
              <div
                className="fixed z-50 bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border text-sm pointer-events-none"
                style={{
                  left: hoveredSlot.x + 10,
                  top: hoveredSlot.y + 10,
                }}
              >
                <div className="font-medium">Slot {hoveredSlot.slot}</div>
                <div className="text-muted-foreground">
                  Keys: {hoveredSlot.keyCount.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground font-mono truncate max-w-[200px]">
                  Node: {hoveredSlot.nodeId.substring(0, 12)}...
                </div>
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">Key density:</span>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 rounded" style={{ backgroundColor: 'var(--muted)' }} />
                <span className="text-xs">Empty</span>
              </div>
              <div className="flex items-center gap-1">
                <div
                  className="w-4 h-4 rounded"
                  style={{ backgroundColor: 'color-mix(in oklch, var(--primary) 30%, transparent)' }}
                />
                <span className="text-xs">Low</span>
              </div>
              <div className="flex items-center gap-1">
                <div
                  className="w-4 h-4 rounded"
                  style={{ backgroundColor: 'color-mix(in oklch, var(--primary) 60%, transparent)' }}
                />
                <span className="text-xs">Medium</span>
              </div>
              <div className="flex items-center gap-1">
                <div
                  className="w-4 h-4 rounded"
                  style={{ backgroundColor: 'var(--primary)' }}
                />
                <span className="text-xs">High</span>
              </div>
            </div>
          </div>

          {/* Stats Summary */}
          {slotStats && (
            <div className="grid grid-cols-3 gap-4 pt-4 border-t">
              <div>
                <div className="text-xs text-muted-foreground">Total Keys</div>
                <div className="text-lg font-bold">
                  {Object.values(slotStats)
                    .reduce((sum, s) => sum + s.key_count, 0)
                    .toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Populated Slots</div>
                <div className="text-lg font-bold">
                  {Object.values(slotStats).filter((s) => s.key_count > 0).length}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Avg Keys/Slot</div>
                <div className="text-lg font-bold">
                  {(
                    Object.values(slotStats).reduce((sum, s) => sum + s.key_count, 0) /
                    Math.max(Object.values(slotStats).filter((s) => s.key_count > 0).length, 1)
                  ).toFixed(1)}
                </div>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
