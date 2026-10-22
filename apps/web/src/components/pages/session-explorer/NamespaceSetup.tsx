import { useId, useState, type ReactNode } from 'react';
import type {
  CustomSchema,
  PresetId,
  SessionNamespace,
  SessionNamespaceInput,
  SessionPreview,
} from '@betterdb/shared';
import { sessionExplorerApi } from '../../../api/session-explorer';
import { ApiError } from '../../../api/client';
import { Alert, AlertDescription } from '../../ui/alert';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Input } from '../../ui/input';
import { KeyPanel } from './KeyPanel';

const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: 'langchain-community', label: 'LangChain (Python, community)' },
  { id: 'langchain-js', label: 'LangChain.js' },
  { id: 'llamaindex', label: 'LlamaIndex' },
  { id: 'agent-cache', label: 'BetterDB agent-cache' },
  { id: 'custom', label: 'Custom schema' },
  { id: 'raw', label: 'Raw (no parsing)' },
];

const DEFAULT_THRESHOLD = 1048576;

const SELECT_CLASS = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

interface SchemaDraft {
  sessionTemplate: string;
  valueType: CustomSchema['valueType'];
  from: 'items' | 'path' | 'key';
  path: string;
  role: string;
  content: string;
  timestamp: string;
  toolName: string;
  toolArgs: string;
  toolResult: string;
}

const emptySchema = (schema: CustomSchema | null | undefined): SchemaDraft => ({
  sessionTemplate: schema?.sessionTemplate ?? '',
  valueType: schema?.valueType ?? 'list',
  from: schema?.messages.from ?? 'items',
  path: schema?.messages.from === 'path' ? schema.messages.path : '',
  role: schema?.fields.role ?? '',
  content: schema?.fields.content ?? '',
  timestamp: schema?.fields.timestamp ?? '',
  toolName: schema?.fields.toolName ?? '',
  toolArgs: schema?.fields.toolArgs ?? '',
  toolResult: schema?.fields.toolResult ?? '',
});

const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());

function toSchema(d: SchemaDraft): CustomSchema {
  const fields: CustomSchema['fields'] = { role: d.role.trim(), content: d.content.trim() };
  const extras = {
    timestamp: optional(d.timestamp),
    toolName: optional(d.toolName),
    toolArgs: optional(d.toolArgs),
    toolResult: optional(d.toolResult),
  };
  for (const [name, value] of Object.entries(extras)) {
    if (value !== undefined) fields[name as keyof typeof extras] = value;
  }
  return {
    ...(optional(d.sessionTemplate) !== undefined
      ? { sessionTemplate: d.sessionTemplate.trim() }
      : {}),
    valueType: d.valueType,
    messages: d.from === 'path' ? { from: 'path', path: d.path.trim() } : { from: d.from },
    fields,
  };
}

function errorsOf(err: unknown): string[] {
  if (err instanceof ApiError && typeof err.payload === 'object' && err.payload !== null) {
    const errors = (err.payload as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.every((e) => typeof e === 'string')) return errors;
  }
  return [err instanceof Error ? err.message : 'Request failed'];
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

interface Props {
  initial?: SessionNamespace;
  onSaved: (ns: SessionNamespace) => void;
  onCancel: () => void;
}

export function NamespaceSetup({ initial, onSaved, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [pattern, setPattern] = useState(initial?.pattern ?? '');
  const [preset, setPreset] = useState<PresetId>(initial?.preset ?? 'langchain-community');
  const [threshold, setThreshold] = useState(
    String(initial?.oversizeThresholdBytes ?? DEFAULT_THRESHOLD),
  );
  const [schema, setSchema] = useState<SchemaDraft>(() => emptySchema(initial?.customSchema));
  const [errors, setErrors] = useState<string[]>([]);
  const [previewed, setPreviewed] = useState<{ input: string; result: SessionPreview } | null>(
    null,
  );
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);

  const setField = (field: keyof SchemaDraft) => (value: string) =>
    setSchema((prev) => ({ ...prev, [field]: value }));

  const input = (): SessionNamespaceInput => ({
    name,
    pattern,
    preset,
    customSchema: preset === 'custom' ? toSchema(schema) : null,
    oversizeThresholdBytes: Number(threshold),
  });

  const preview =
    previewed && previewed.input === JSON.stringify(input()) ? previewed.result : null;

  const run = async (kind: 'preview' | 'save') => {
    setBusy(kind);
    setErrors([]);
    try {
      if (kind === 'preview') {
        setPreviewed(null);
        const body = input();
        const result = await sessionExplorerApi.preview(body);
        setPreviewed({ input: JSON.stringify(body), result });
      } else {
        const saved = initial
          ? await sessionExplorerApi.updateNamespace(initial.id, input())
          : await sessionExplorerApi.createNamespace(input());
        onSaved(saved);
      }
    } catch (err) {
      setErrors(errorsOf(err));
    } finally {
      setBusy(null);
    }
  };

  const text = (label: string, field: keyof SchemaDraft, placeholder?: string) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          value={schema[field]}
          placeholder={placeholder}
          onChange={(e) => setField(field)(e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{initial ? 'Edit namespace' : 'New namespace'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Key pattern">
            {(id) => (
              <Input
                id={id}
                value={pattern}
                placeholder="message_store:*"
                onChange={(e) => setPattern(e.target.value)}
              />
            )}
          </Field>
          <Field label="Preset">
            {(id) => (
              <select
                id={id}
                className={SELECT_CLASS}
                value={preset}
                onChange={(e) => setPreset(e.target.value as PresetId)}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Oversize threshold (bytes)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            )}
          </Field>
        </div>

        {preset === 'custom' && (
          <div className="grid gap-4 rounded-md border p-3 md:grid-cols-2">
            <Field label="Value type">
              {(id) => (
                <select
                  id={id}
                  className={SELECT_CLASS}
                  value={schema.valueType}
                  onChange={(e) => setField('valueType')(e.target.value)}
                >
                  <option value="list">List</option>
                  <option value="string">String</option>
                  <option value="hash">Hash</option>
                  <option value="json">JSON</option>
                </select>
              )}
            </Field>
            <Field label="Messages from">
              {(id) => (
                <select
                  id={id}
                  className={SELECT_CLASS}
                  value={schema.from}
                  onChange={(e) => setField('from')(e.target.value)}
                >
                  <option value="items">Each item</option>
                  <option value="path">A path in the value</option>
                  <option value="key">The whole key</option>
                </select>
              )}
            </Field>
            {schema.from === 'path' && text('Messages path', 'path', 'messages')}
            {text('Session id template', 'sessionTemplate', 'chat:{session}')}
            {text('Role field', 'role', 'role')}
            {text('Content field', 'content', 'content')}
            {text('Timestamp field', 'timestamp')}
            {text('Tool name field', 'toolName')}
            {text('Tool args field', 'toolArgs')}
            {text('Tool result field', 'toolResult')}
          </div>
        )}

        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-disc ps-4">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run('save')} disabled={busy !== null}>
            Save
          </Button>
          <Button variant="outline" onClick={() => run('preview')} disabled={busy !== null}>
            Preview
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        </div>

        {preview &&
          (preview.view ? (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Preview of one sampled key</p>
              <KeyPanel key={preview.sampleKey} view={preview.view} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {preview.sampleKey !== null
                ? `Matched ${preview.sampleKey}, but it could not be read. It may have expired.`
                : preview.exhausted
                  ? 'No key matched this pattern.'
                  : 'No matching key in the first 10,000 keys scanned on each node.'}
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
