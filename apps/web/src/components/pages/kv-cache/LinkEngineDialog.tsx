import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { KvCacheEngine, KvCacheEngineCreate } from '@betterdb/shared';
import { apiOrigin } from '../../../api/client';
import { kvCacheApi } from '../../../api/kv-cache';
import { copyToClipboard } from '../../../lib/clipboard';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
import { collectorSnippet } from './collector-snippet';
import { useInvalidateEngines } from './useInvalidateEngines';

type Source = 'scrape' | 'otlp';

export function LinkEngineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { capture, invalidate } = useInvalidateEngines();
  const [source, setSource] = useState<Source>('scrape');
  const [scrapeName, setScrapeName] = useState('');
  const [otlpName, setOtlpName] = useState('');
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [otlpId, setOtlpId] = useState('');
  const [created, setCreated] = useState<KvCacheEngine | null>(null);
  const [copied, setCopied] = useState(false);

  const session = useRef(0);

  useEffect(() => {
    session.current += 1;
  }, [open]);

  const create = useMutation({
    mutationFn: (body: KvCacheEngineCreate) => kvCacheApi.createEngine(body),
    onMutate: capture,
    onSuccess: (_data, _variables, context) => invalidate(context),
  });

  const submit = (body: KvCacheEngineCreate) => {
    const started = session.current;
    create.mutate(body, {
      onSettled: () => {
        if (session.current !== started) create.reset();
      },
      onSuccess: (engine) => {
        if (session.current !== started) return;
        if (engine.source === 'otlp') {
          setCreated(engine);
        } else {
          close(false);
        }
      },
    });
  };

  const reset = () => {
    setScrapeName('');
    setOtlpName('');
    setScrapeUrl('');
    setAuthHeader('');
    setOtlpId('');
    setCreated(null);
    setCopied(false);
    if (!create.isPending) create.reset();
  };

  const close = (next: boolean) => {
    if (!next) {
      session.current += 1;
      reset();
    }
    onOpenChange(next);
  };

  const submitScrape = () => {
    const body: KvCacheEngineCreate = { name: scrapeName.trim(), source: 'scrape', scrapeUrl: scrapeUrl.trim() };
    if (authHeader.trim()) body.scrapeAuthHeader = authHeader.trim();
    submit(body);
  };

  const submitOtlp = () => {
    const body: KvCacheEngineCreate = { name: otlpName.trim(), source: 'otlp' };
    if (otlpId.trim()) body.otlpEngineId = otlpId.trim();
    submit(body);
  };

  const snippet = created?.otlpEngineId
    ? collectorSnippet(created.otlpEngineId, apiOrigin())
    : null;

  const copy = async () => {
    if (!snippet) return;
    setCopied(await copyToClipboard(snippet));
  };

  const error = create.error instanceof Error ? create.error.message : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link LMCache engine</DialogTitle>
          <DialogDescription>
            Scrape an engine's Prometheus endpoint, or have an OpenTelemetry Collector push its
            metrics.
          </DialogDescription>
        </DialogHeader>
        {snippet && created ? (
          <div className="space-y-3">
            <p className="text-sm">
              Engine id: <code className="font-mono">{created.otlpEngineId}</code>
            </p>
            <pre
              data-testid="collector-snippet"
              className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs"
            >
              {snippet}
            </pre>
            <DialogFooter>
              <Button variant="outline" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <Tabs
            value={source}
            onValueChange={(value) => {
              if (create.isPending) return;
              setSource(value as Source);
              create.reset();
            }}
          >
            <TabsList>
              <TabsTrigger value="scrape" disabled={create.isPending && source !== 'scrape'}>
                Scrape
              </TabsTrigger>
              <TabsTrigger value="otlp" disabled={create.isPending && source !== 'otlp'}>
                OTLP
              </TabsTrigger>
            </TabsList>
            <TabsContent value="scrape" className="space-y-3">
              <Field label="Name" value={scrapeName} onChange={setScrapeName} />
              <Field
                label="Metrics URL"
                value={scrapeUrl}
                onChange={setScrapeUrl}
                placeholder="http://vllm:8000/metrics"
              />
              <Field
                label="Auth header (optional)"
                value={authHeader}
                onChange={setAuthHeader}
                type="password"
                placeholder="Bearer <token>"
              />
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter>
                <Button
                  onClick={submitScrape}
                  disabled={create.isPending || !scrapeName.trim() || !scrapeUrl.trim()}
                >
                  Save
                </Button>
              </DialogFooter>
            </TabsContent>
            <TabsContent value="otlp" className="space-y-3">
              <Field label="Name" value={otlpName} onChange={setOtlpName} />
              <Field label="Engine id (optional)" value={otlpId} onChange={setOtlpId} />
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter>
                <Button onClick={submitOtlp} disabled={create.isPending || !otlpName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <Input
        aria-label={label}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
