import { parseView } from './cluster';
import { readTrace } from './trace';

export function inspect(file: string, every = 1): string {
  const { meta, ticks } = readTrace(file);
  const idToName = new Map(meta.nodes.map((node) => [node.id, node.name]));
  const out: string[] = [];
  out.push(
    `${meta.trial} lane=${meta.lane} valkey=${meta.valkey} nodeTimeout=${meta.nodeTimeoutMs} ` +
      `t0=${meta.t0} windowEnd=${meta.windowEnd} end=${meta.end} targets=${meta.targets.join(',')} ` +
      `minority=${meta.minority.join(',')} late=${JSON.stringify(meta.late)}`,
  );
  out.push(`nodes: ${meta.nodes.map((n) => `${n.name}=${n.role}@${n.zone}${n.primary ? `<-${n.primary}` : ''}`).join(' ')}`);
  for (const event of meta.events) out.push(`  event t=${event.t} ${event.type} ${JSON.stringify(event.detail ?? '')}`);
  const names = meta.nodes.map((node) => node.name);
  let previous = '';
  ticks.forEach((tick, index) => {
    const cells = names.map((name) => {
      const sample = tick.nodes[name];
      if (!sample) return `${name}:?`;
      if (!sample.ok) return `${name}:--(${sample.err.slice(0, 12)})`;
      const lines = parseView(sample.nodes);
      const self = lines.find((line) => line.flags.includes('myself'));
      const role = self?.flags.includes('master') ? 'M' : 'S';
      const owners = lines
        .filter((line) => line.slots && !line.slots.startsWith('['))
        .map((line) => idToName.get(line.id) ?? '??')
        .sort()
        .join('');
      const flagged = (flag: string) =>
        lines
          .filter((line) => line.flags.includes(flag))
          .map((line) => idToName.get(line.id) ?? '??')
          .join('');
      const pfail = flagged('fail?');
      const fail = flagged('fail');
      const handshake = lines.filter((line) => line.flags.includes('handshake')).length;
      return (
        `${name}:${role}${sample.info.state === 'ok' ? '' : '!'} k${lines.length} o[${owners}]` +
        `${pfail ? ` p[${pfail}]` : ''}${fail ? ` f[${fail}]` : ''}${handshake ? ` h${handshake}` : ''}` +
        `${Array.isArray(sample.migrations) && sample.migrations.length ? ` m${sample.migrations.length}` : ''}`
      );
    });
    const line = cells.join(' | ');
    if (line !== previous || index % every === 0 && every > 1) out.push(`t=${String(tick.t / 1000).padStart(4)} late=${tick.late} ${line}`);
    previous = line;
  });
  return out.join('\n');
}
