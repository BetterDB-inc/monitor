import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import type { SlowLogPatternAnalysis } from '../../types/metrics';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDurationUs } from '../../lib/utils';

interface Props {
  analysis: SlowLogPatternAnalysis;
}

const COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-warning)',
  'var(--chart-info)',
  'var(--chart-critical)',
];

export function SlowLogPatternAnalysisView({ analysis }: Props) {
  const [expandedPatterns, setExpandedPatterns] = useState<Set<string>>(
    new Set()
  );

  const togglePattern = (pattern: string) => {
    setExpandedPatterns((prev) => {
      const next = new Set(prev);
      if (next.has(pattern)) {
        next.delete(pattern);
      } else {
        next.add(pattern);
      }
      return next;
    });
  };

  const formatDuration = formatDurationUs;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{analysis.totalEntries}</div>
            <div className="text-sm text-muted-foreground">
              Total Slow Queries
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{analysis.patterns.length}</div>
            <div className="text-sm text-muted-foreground">
              Unique Patterns
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">
              {analysis.byCommand.length}
            </div>
            <div className="text-sm text-muted-foreground">Command Types</div>
          </CardContent>
        </Card>
      </div>

      {/* Top Pattern Insight Banner */}
      {analysis.patterns.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="text-lg font-semibold">
              {analysis.patterns[0].pattern} accounts for{' '}
              {analysis.patterns[0].percentage.toFixed(1)}% of slow queries
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              Average duration: {formatDuration(analysis.patterns[0].avgDuration)}{' '}
              • {analysis.patterns[0].count} occurrences
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pattern Distribution Visualization */}
      <Card>
        <CardHeader>
          <CardTitle>Pattern Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {analysis.patterns.slice(0, 8).map((pattern, i) => (
              <div key={pattern.pattern} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-mono flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: COLORS[i % COLORS.length] }}
                    />
                    {pattern.pattern}
                  </span>
                  <span className="font-semibold">
                    {pattern.percentage.toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-secondary rounded-full h-2">
                  <div
                    className="h-2 rounded-full transition-all"
                    style={{
                      width: `${pattern.percentage}%`,
                      backgroundColor: COLORS[i % COLORS.length],
                    }}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {pattern.count} queries • avg{' '}
                  {formatDuration(pattern.avgDuration)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Command Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>By Command</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            {analysis.byCommand.slice(0, 10).map((cmd) => (
              <div
                key={cmd.command}
                className="px-3 py-2 bg-muted rounded-lg text-sm"
              >
                <span className="font-mono font-semibold">{cmd.command}</span>
                <span className="text-muted-foreground ml-2">
                  {cmd.percentage.toFixed(1)}% ({cmd.count})
                </span>
                <div className="text-xs text-muted-foreground mt-1">
                  avg {formatDuration(cmd.avgDuration)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Key Prefix Breakdown */}
      {analysis.byKeyPrefix.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By Key Prefix</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              {analysis.byKeyPrefix.slice(0, 10).map((prefix) => (
                <div
                  key={prefix.prefix}
                  className="px-3 py-2 bg-muted rounded-lg text-sm"
                >
                  <span className="font-mono font-semibold">
                    {prefix.prefix}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    {prefix.percentage.toFixed(1)}% ({prefix.count})
                  </span>
                  <div className="text-xs text-muted-foreground mt-1">
                    avg {formatDuration(prefix.avgDuration)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Client Breakdown */}
      {analysis.byClient && analysis.byClient.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By Client</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              {analysis.byClient.slice(0, 10).map((client) => (
                <div
                  key={client.clientIdentifier}
                  className="px-3 py-2 bg-muted rounded-lg text-sm"
                >
                  <span className="font-mono font-semibold">
                    {client.clientIdentifier}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    {client.percentage.toFixed(1)}% ({client.count})
                  </span>
                  <div className="text-xs text-muted-foreground mt-1">
                    avg {formatDuration(client.avgDuration)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detailed Pattern Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Patterns</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">%</TableHead>
                <TableHead className="text-right">Avg Duration</TableHead>
                <TableHead className="text-right">Max Duration</TableHead>
                <TableHead className="text-right">Total Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.patterns.map((pattern, i) => (
                <React.Fragment key={pattern.pattern}>
                  <TableRow
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => togglePattern(pattern.pattern)}
                  >
                    <TableCell>
                      {expandedPatterns.has(pattern.pattern) ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor: COLORS[i % COLORS.length],
                          }}
                        />
                        {pattern.pattern}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{pattern.count}</TableCell>
                    <TableCell className="text-right">
                      {pattern.percentage.toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatDuration(pattern.avgDuration)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatDuration(pattern.maxDuration)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatDuration(pattern.totalDuration)}
                    </TableCell>
                  </TableRow>
                  {expandedPatterns.has(pattern.pattern) && (
                    <TableRow key={`${pattern.pattern}-details`}>
                      <TableCell colSpan={7} className="bg-muted/30 p-0">
                        <div className="p-4">
                          <h4 className="text-sm font-semibold mb-3">
                            Client Breakdown
                          </h4>
                          {pattern.clientBreakdown.length > 0 ? (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Client</TableHead>
                                  <TableHead className="text-right">
                                    Count
                                  </TableHead>
                                  <TableHead className="text-right">
                                    % of Pattern
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Avg Duration
                                  </TableHead>
                                  <TableHead className="text-right">
                                    Max Duration
                                  </TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {pattern.clientBreakdown.map((client) => (
                                  <TableRow key={client.clientIdentifier}>
                                    <TableCell className="font-mono text-sm">
                                      {client.clientIdentifier}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {client.count}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {client.percentage.toFixed(1)}%
                                    </TableCell>
                                    <TableCell className="text-right font-mono">
                                      {formatDuration(client.avgDuration)}
                                    </TableCell>
                                    <TableCell className="text-right font-mono">
                                      {formatDuration(client.maxDuration)}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              No client breakdown available
                            </p>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
