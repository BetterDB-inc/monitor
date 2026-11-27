import { KubeApiError } from '../kube-client';
import { loadFingerprintKey } from '../fingerprint-key';

// A Secret API holding at most one object, enough for create-or-read.
class FakeKube {
  namespace = 'plugins';
  secret: { metadata: { name: string }; data?: Record<string, string> } | null = null;
  posts = 0;
  // Simulates another pod creating the Secret between our read and our create.
  raceWith: Record<string, string> | null = null;

  async get(path: string) {
    if (!this.secret) throw new KubeApiError(404, path, 'not found');
    return JSON.parse(JSON.stringify(this.secret));
  }

  async post(path: string, body: { metadata: { name: string }; data: Record<string, string> }) {
    this.posts += 1;
    if (this.raceWith) {
      this.secret = { metadata: body.metadata, data: this.raceWith };
      throw new KubeApiError(409, path, 'already exists');
    }
    this.secret = { metadata: body.metadata, data: body.data };
    return this.secret;
  }
}

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('loadFingerprintKey', () => {
  it('creates the Secret with a random key on first start and reads the same key back after', async () => {
    const kube = new FakeKube();

    const first = await loadFingerprintKey(kube as never, 'betterdb-fingerprint');
    const second = await loadFingerprintKey(kube as never, 'betterdb-fingerprint');

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(kube.posts).toBe(1);
    expect(kube.secret?.metadata.name).toBe('betterdb-fingerprint');
  });

  it('generates a different key per Secret', async () => {
    const a = await loadFingerprintKey(new FakeKube() as never, 'k');
    const b = await loadFingerprintKey(new FakeKube() as never, 'k');
    expect(a.equals(b)).toBe(false);
  });

  it('uses the key another pod created first', async () => {
    const kube = new FakeKube();
    kube.raceWith = { key: KEY };

    const key = await loadFingerprintKey(kube as never, 'k');

    expect(key.toString('base64')).toBe(KEY);
  });

  it('refuses a Secret without a usable key instead of replacing it', async () => {
    const kube = new FakeKube();
    kube.secret = { metadata: { name: 'k' }, data: { key: Buffer.from('short').toString('base64') } };

    await expect(loadFingerprintKey(kube as never, 'k')).rejects.toThrow(/no usable "key"/);
    expect(kube.posts).toBe(0);
  });

  it('passes other API errors through', async () => {
    const kube = new FakeKube();
    kube.get = async (path: string) => { throw new KubeApiError(403, path, 'forbidden'); };

    await expect(loadFingerprintKey(kube as never, 'k')).rejects.toThrow(/403/);
  });
});
