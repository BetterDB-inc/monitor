import { KubeApiError, KubeClient, KubeObject } from './kube-client';

// The key node agents tag redacted secrets with (see secretFingerprint). It is
// random and lives in a Secret in the plugin's namespace that only the plugin
// reads: a key derived from anything the server could see or guess, such as
// the instance password, would let it test password guesses offline against
// the tags. The chart renders the Secret (or the user brings one); the backend
// only reads it, since `create` on secrets would let its ServiceAccount mint
// tokens for other ServiceAccounts in the namespace. Shared by every instance
// so drift between them still shows.

export const FINGERPRINT_KEY_FIELD = 'key';
const KEY_BYTES = 32;

interface Secret extends KubeObject {
  data?: Record<string, string>;
}

export async function loadFingerprintKey(client: KubeClient, name: string, namespace = client.namespace): Promise<Buffer> {
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;
  let secret: Secret;
  try {
    secret = await client.get<Secret>(path);
  } catch (err) {
    if (err instanceof KubeApiError && err.status === 404) {
      throw new Error(`Secret ${namespace}/${name} with the fingerprint key does not exist; the chart creates it, ` +
        'or create it with `key` set to at least 32 random bytes');
    }
    throw err;
  }
  // A damaged key fails startup instead of falling back to none: plain
  // <redacted> tags would hide every secret change until it is fixed.
  const key = Buffer.from(secret.data?.[FINGERPRINT_KEY_FIELD] ?? '', 'base64');
  if (key.length < KEY_BYTES) {
    throw new Error(`Secret ${namespace}/${name} has no usable "${FINGERPRINT_KEY_FIELD}" (need at least ${KEY_BYTES} random bytes)`);
  }
  return key;
}
