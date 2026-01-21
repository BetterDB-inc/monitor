import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import {
  select,
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  drag,
  zoom,
  zoomIdentity,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
  type ZoomBehavior,
} from 'd3';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Network, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { formatBytes } from '../../lib/utils';
import { countSlots } from '../../types/cluster';
import type { ClusterNode } from '../../types/metrics';
import type { NodeStats } from '../../types/cluster';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  address: string;
  role: 'master' | 'replica';
  masterId?: string;
  slots: number[][];
  stats?: NodeStats;
  healthy: boolean;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  type: 'replication';
}

interface ClusterTopologyGraphProps {
  nodes: ClusterNode[];
  nodeStats?: NodeStats[];
  viewToggle: React.ReactNode;
}

const NODE_RADIUS = 25;
const NODE_PADDING = 10;
const LINK_DISTANCE = 150;
const CHARGE_STRENGTH = -300;
const DEFAULT_CONTAINER_WIDTH = 800;
const CONTAINER_HEIGHT = 600;

const MASTER_COLOR = 'hsl(var(--chart-1))';
const REPLICA_COLOR = 'hsl(var(--chart-5))';
const UNHEALTHY_COLOR = 'hsl(var(--destructive))';
const LINK_COLOR = 'hsl(var(--muted-foreground))';
const TEXT_COLOR = 'hsl(var(--muted-foreground))';
const NODE_STROKE_COLOR = 'hsl(var(--background))';

export function ClusterTopologyGraph({ nodes, nodeStats, viewToggle }: ClusterTopologyGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [containerWidth, setContainerWidth] = useState(DEFAULT_CONTAINER_WIDTH);

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width > 0) {
          setContainerWidth(width);
        }
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const { graphNodes, graphLinks } = useMemo(() => {
    if (!nodes || nodes.length === 0) {
      return { graphNodes: [], graphLinks: [] };
    }

    const graphNodes: GraphNode[] = nodes.map((node) => {
      const savedPos = nodePositionsRef.current.get(node.id);
      return {
        id: node.id,
        address: node.address,
        role: node.flags.includes('master') ? 'master' : 'replica',
        masterId: node.master && node.master !== '-' ? node.master : undefined,
        slots: node.slots,
        stats: nodeStats?.find((s) => s.nodeId === node.id),
        healthy: node.linkState === 'connected' && !node.flags.includes('fail'),
        x: savedPos?.x,
        y: savedPos?.y,
      };
    });

    const graphLinks: GraphLink[] = [];
    for (const gNode of graphNodes) {
      if (gNode.role === 'replica' && gNode.masterId) {
        graphLinks.push({
          source: gNode.masterId,
          target: gNode.id,
          type: 'replication',
        });
      }
    }

    return { graphNodes, graphLinks };
  }, [nodes, nodeStats]);

  useEffect(() => {
    if (!svgRef.current || graphNodes.length === 0) return;

    const svg = select(svgRef.current);
    svg.selectAll('*').remove();

    const width = containerWidth;
    const height = CONTAINER_HEIGHT;

    const g = svg.append('g');

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    zoomBehaviorRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    // Only run simulation for new nodes (without saved positions)
    const needsSimulation = graphNodes.some((n) => n.x === undefined || n.y === undefined);

    const simulation = forceSimulation<GraphNode>(graphNodes)
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(graphLinks)
          .id((d) => d.id)
          .distance(LINK_DISTANCE)
      )
      .force('charge', forceManyBody().strength(CHARGE_STRENGTH))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collision', forceCollide().radius(NODE_RADIUS + NODE_PADDING))
      .alpha(needsSimulation ? 1 : 0)
      .alphaDecay(needsSimulation ? 0.0228 : 1);

    const link = g
      .append('g')
      .selectAll('line')
      .data(graphLinks)
      .join('line')
      .attr('stroke', LINK_COLOR)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5,5')
      .attr('marker-end', 'url(#arrowhead)');

    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', NODE_RADIUS + 15)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', LINK_COLOR);

    const dragBehavior = drag<SVGGElement, GraphNode>()
      .on('start', function (event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', function (event, d) {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', function (event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        // Save new position after drag
        if (d.x !== undefined && d.y !== undefined) {
          nodePositionsRef.current.set(d.id, { x: d.x, y: d.y });
        }
      });

    const node = g
      .append('g')
      .selectAll<SVGGElement, GraphNode>('g')
      .data(graphNodes)
      .join('g')
      .call(dragBehavior);

    node
      .append('circle')
      .attr('r', NODE_RADIUS)
      .attr('fill', (d) => {
        if (!d.healthy) return UNHEALTHY_COLOR;
        return d.role === 'master' ? MASTER_COLOR : REPLICA_COLOR;
      })
      .attr('stroke', NODE_STROKE_COLOR)
      .attr('stroke-width', 3);

    node
      .append('text')
      .text((d) => {
        const addr = d.address.split(':')[0];
        return addr.length > 12 ? addr.substring(0, 12) + '...' : addr;
      })
      .attr('text-anchor', 'middle')
      .attr('dy', NODE_RADIUS + 15)
      .attr('fill', TEXT_COLOR)
      .attr('font-size', '11px')
      .attr('font-weight', 'bold');

    node
      .append('text')
      .text((d) => (d.role === 'master' ? 'M' : 'R'))
      .attr('text-anchor', 'middle')
      .attr('dy', 5)
      .attr('fill', NODE_STROKE_COLOR)
      .attr('font-size', '14px')
      .attr('font-weight', 'bold');

    node.append('title').text((d) => {
      const slotCount = countSlots(d.slots);
      return (
        `${d.address}\nRole: ${d.role}\n` +
        `Slots: ${slotCount > 0 ? slotCount.toLocaleString() : 'none'}\n` +
        `Memory: ${d.stats ? formatBytes(d.stats.memoryUsed) : 'N/A'}\n` +
        `Ops/sec: ${d.stats ? d.stats.opsPerSec.toLocaleString() : 'N/A'}\n` +
        `Clients: ${d.stats ? d.stats.connectedClients : 'N/A'}`
      );
    });

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as GraphNode).x || 0)
        .attr('y1', (d) => (d.source as GraphNode).y || 0)
        .attr('x2', (d) => (d.target as GraphNode).x || 0)
        .attr('y2', (d) => (d.target as GraphNode).y || 0);

      node.attr('transform', (d) => `translate(${d.x || 0},${d.y || 0})`);
    });

    // Save positions when simulation ends
    simulation.on('end', () => {
      graphNodes.forEach((n) => {
        if (n.x !== undefined && n.y !== undefined) {
          nodePositionsRef.current.set(n.id, { x: n.x, y: n.y });
        }
      });
    });

    return () => {
      simulation.stop();
    };
  }, [graphNodes, graphLinks, containerWidth]);

  const handleZoomIn = useCallback(() => {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    select(svgRef.current).transition().duration(300).call(zoomBehaviorRef.current.scaleBy, 1.3);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    select(svgRef.current).transition().duration(300).call(zoomBehaviorRef.current.scaleBy, 0.7);
  }, []);

  const handleResetZoom = useCallback(() => {
    if (!svgRef.current || !zoomBehaviorRef.current) return;
    select(svgRef.current).transition().duration(300).call(zoomBehaviorRef.current.transform, zoomIdentity);
  }, []);

  if (graphNodes.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center text-muted-foreground">No cluster nodes available</div>
        </CardContent>
      </Card>
    );
  }

  const masterCount = graphNodes.filter((n) => n.role === 'master').length;
  const replicaCount = graphNodes.filter((n) => n.role === 'replica').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <CardTitle className="flex items-center gap-2">
              <Network className="w-5 h-5" />
              Cluster Topology Graph
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-[hsl(var(--chart-1))]/10 text-[hsl(var(--chart-1))] border-[hsl(var(--chart-1))]/20">
                {masterCount} Masters
              </Badge>
              <Badge variant="outline" className="bg-[hsl(var(--chart-5))]/10 text-[hsl(var(--chart-5))] border-[hsl(var(--chart-5))]/20">
                {replicaCount} Replicas
              </Badge>
            </div>
          </div>
          {viewToggle}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-[hsl(var(--chart-1))]"></div>
                <span>Master</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-[hsl(var(--chart-5))]"></div>
                <span>Replica</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-full bg-[hsl(var(--destructive))]"></div>
                <span>Unhealthy</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleZoomIn}
                className="p-2 hover:bg-muted rounded-md transition-colors"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={handleZoomOut}
                className="p-2 hover:bg-muted rounded-md transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                onClick={handleResetZoom}
                className="p-2 hover:bg-muted rounded-md transition-colors"
                title="Reset Zoom"
              >
                <Maximize className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div ref={containerRef} className="border rounded-lg bg-muted/20 overflow-hidden">
            <svg
              ref={svgRef}
              width="100%"
              height={CONTAINER_HEIGHT}
              style={{ cursor: 'grab' }}
            />
          </div>

          <div className="text-xs text-muted-foreground">
            <strong>Drag</strong> nodes to reposition | <strong>Scroll</strong> to zoom | <strong>Hover</strong> for details
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
