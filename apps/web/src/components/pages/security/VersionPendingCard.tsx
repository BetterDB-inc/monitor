import { Button } from '../../ui/button';
import type { VersionPending } from './scan-error';

const VALKEY_RESOURCE_PROCESSOR = `processors:
  resource/valkey:
    attributes:
      - key: valkey.version
        value: '8.1.1'
        action: upsert
      - key: db.system.name
        value: valkey
        action: upsert

service:
  pipelines:
    metrics:
      receivers: [redis]
      processors: [resource/valkey]
      exporters: [otlphttp/betterdb]`;

interface VersionPendingCardProps {
  pending: VersionPending;
  retrying: boolean;
  onRetry: () => void;
}

export function VersionPendingCard({ pending, retrying, onRetry }: VersionPendingCardProps) {
  const valkey = pending.product === 'valkey';

  return (
    <section
      data-testid="version-pending"
      className="flex flex-1 flex-col items-center justify-center gap-5 text-center"
    >
      <span className="border-chart-warning/45 bg-chart-warning/15 flex size-[72px] items-center justify-center rounded-full border">
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--chart-warning)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>

      <div className="flex flex-col items-center gap-2">
        <h2 data-testid="verdict-headline" className="text-2xl font-semibold tracking-tight">
          Waiting for a version from the collector
        </h2>
        {valkey ? (
          <p
            data-testid="version-pending-detail"
            className="text-muted-foreground max-w-[580px] text-sm leading-[22px] text-pretty"
          >
            Valkey reports <code>redis_version 7.2.4</code> for client compatibility, so that number says nothing about the Valkey release running here. Monitor needs the <code>{pending.attribute}</code> resource attribute, and CVE matching starts on the first push that carries it. Add a resource processor to the collector and set <code>value</code> to the Valkey version you run:
          </p>
        ) : (
          <p
            data-testid="version-pending-detail"
            className="text-muted-foreground max-w-[580px] text-sm leading-[22px] text-pretty"
          >
            Monitor has not received a version for this instance from the collector yet. CVE matching starts on the first push that carries <code>{pending.attribute}</code>.
          </p>
        )}
      </div>

      {valkey ? (
        <pre
          data-testid="valkey-version-snippet"
          className="bg-muted max-w-[580px] overflow-x-auto rounded-md border p-4 text-left text-xs leading-5"
        >
          <code>{VALKEY_RESOURCE_PROCESSOR}</code>
        </pre>
      ) : null}

      <Button onClick={onRetry} disabled={retrying}>
        {retrying ? 'Checking…' : 'Check again'}
      </Button>
    </section>
  );
}
