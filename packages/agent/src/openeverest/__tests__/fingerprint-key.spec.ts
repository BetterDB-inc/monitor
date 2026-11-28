import { KubeApiError } from '../kube-client';
import { loadFingerprintKey } from '../fingerprint-key';

// A Secret API holding at most one object; the loader may only read it.
class FakeKube {
  namespace = 'plugins';
  secret: { metadata: { name: string }; data?: Record<string, string> } | null = null;
  paths: string[] = [];

  async get(path: string) {
    this.paths.push(path);
    if (!this.secret) throw new KubeApiError(404, path, 'not found');
    return JSON.parse(JSON.stringify(this.secret));
  }
}

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('loadFingerprintKey', () => {
  it('reads the key from the named Secret in the plugin namespace', async () => {
    const kube = new FakeKube();
    kube.secret = { metadata: { name: 'betterdb-fingerprint' }, data: { key: KEY } };

    const key = await loadFingerprintKey(kube as never, 'betterdb-fingerprint');

    expect(key.toString('base64')).toBe(KEY);
    expect(kube.paths).toEqual(['/api/v1/namespaces/plugins/secrets/betterdb-fingerprint']);
  });

  it('fails with a pointer to the chart when the Secret is missing, and never creates it', async () => {
    const kube = new FakeKube();
    await expect(loadFingerprintKey(kube as never, 'k')).rejects.toThrow(/does not exist; the chart creates it/);
    expect((kube as unknown as { post?: unknown }).post).toBeUndefined();
  });

  it('refuses a Secret without a usable key', async () => {
    const kube = new FakeKube();
    kube.secret = { metadata: { name: 'k' }, data: { key: Buffer.from('short').toString('base64') } };
    await expect(loadFingerprintKey(kube as never, 'k')).rejects.toThrow(/no usable "key"/);
    kube.secret = { metadata: { name: 'k' } };
    await expect(loadFingerprintKey(kube as never, 'k')).rejects.toThrow(/no usable "key"/);
  });

  it('passes other API errors through', async () => {
    const kube = new FakeKube();
    kube.get = async (path: string) => { throw new KubeApiError(403, path, 'forbidden'); };
    await expect(loadFingerprintKey(kube as never, 'k')).rejects.toThrow(/403/);
  });
});
