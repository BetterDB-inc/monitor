import { randomBytes } from 'crypto';
import { KubeApiError, KubeClient, KubeObject } from './kube-client';

// The key node agents tag redacted secrets with (see secretFingerprint). It is
// random and lives in a Secret in the plugin's namespace that only the plugin
// reads: a key derived from anything the server could see or guess, such as
// the instance password, would let it test password guesses offline against
// the tags. Kept in a Secret rather than in memory so tags stay the same
// across plugin restarts, and shared by every instance so drift between them
// still shows. The chart never renders it, so an upgrade cannot replace it.

export const FINGERPRINT_KEY_FIELD = 'key';
const KEY_BYTES = 32;

interface Secret extends KubeObject {
  data?: Record<string, string>;
}

/** Reads the key, creating the Secret with a fresh random key on first start. */
export async function loadFingerprintKey(client: KubeClient, name: string, namespace = client.namespace): Promise<Buffer> {
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
  const existing = await read(client, `${path}/${encodeURIComponent(name)}`);
  if (existing) return decode(existing, name);
  try {
    await client.post(path, {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'betterdb-openeverest' } },
      data: { [FINGERPRINT_KEY_FIELD]: randomBytes(KEY_BYTES).toString('base64') },
    });
  } catch (err) {
    // Another pod created it first; use theirs so every pod tags alike.
    if (!(err instanceof KubeApiError && err.status === 409)) throw err;
  }
  const created = await read(client, `${path}/${encodeURIComponent(name)}`);
  if (!created) throw new Error(`Secret ${namespace}/${name} vanished right after it was created`);
  return decode(created, name);
}

async function read(client: KubeClient, path: string): Promise<Secret | null> {
  try {
    return await client.get<Secret>(path);
  } catch (err) {
    if (err instanceof KubeApiError && err.status === 404) return null;
    throw err;
  }
}

// A damaged Secret fails startup instead of being replaced: a new key would
// change every tag and fire a change webhook for every secret at once.
function decode(secret: Secret, name: string): Buffer {
  const key = Buffer.from(secret.data?.[FINGERPRINT_KEY_FIELD] ?? '', 'base64');
  if (key.length < KEY_BYTES) {
    throw new Error(`Secret ${name} has no usable "${FINGERPRINT_KEY_FIELD}" (need ${KEY_BYTES} random bytes); ` +
      'delete it to have a new key generated');
  }
  return key;
}
