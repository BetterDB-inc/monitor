import type Valkey from 'iovalkey';
import {
  applyFieldTtls,
  createHashFieldTtlContext,
  readFieldTtls,
} from '../execution/hash-field-ttl';

const f1 = Buffer.from('f1');
const f2 = Buffer.from('f2');
const f3 = Buffer.from('f3');

type MockClient = { call: jest.Mock; pipeline: jest.Mock };
const asValkey = (client: Partial<MockClient>) => client as unknown as Valkey;

describe('hash-field-ttl / readFieldTtls', () => {
  it('returns numeric TTLs from a supported source and marks it supported', async () => {
    const source = { call: jest.fn().mockResolvedValue([5000, '-1']) };
    const ctx = createHashFieldTtlContext();

    const ttls = await readFieldTtls(asValkey(source), 'h', [f1, f2], ctx);

    expect(ttls).toEqual([5000, -1]);
    expect(ctx.source).toBe('supported');
    expect(source.call).toHaveBeenCalledWith('HPTTL', 'h', 'FIELDS', '2', f1, f2);
  });

  it('returns null on unknown command and does not probe again', async () => {
    const source = {
      call: jest.fn().mockRejectedValue(new Error("ERR unknown command 'HPTTL'")),
    };
    const ctx = createHashFieldTtlContext();

    expect(await readFieldTtls(asValkey(source), 'h', [f1], ctx)).toBeNull();
    expect(ctx.source).toBe('unsupported');
    expect(await readFieldTtls(asValkey(source), 'h2', [f1], ctx)).toBeNull();
    expect(source.call).toHaveBeenCalledTimes(1);
  });

  it('returns null on NOPERM, marks denied, and memoizes', async () => {
    const source = {
      call: jest.fn().mockRejectedValue(new Error('NOPERM this user has no permissions')),
    };
    const ctx = createHashFieldTtlContext();

    expect(await readFieldTtls(asValkey(source), 'h', [f1], ctx)).toBeNull();
    expect(ctx.source).toBe('denied');
    expect(await readFieldTtls(asValkey(source), 'h', [f1], ctx)).toBeNull();
    expect(source.call).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors', async () => {
    const source = { call: jest.fn().mockRejectedValue(new Error('LOADING dataset')) };
    const ctx = createHashFieldTtlContext();

    await expect(readFieldTtls(asValkey(source), 'h', [f1], ctx)).rejects.toThrow('LOADING');
    expect(ctx.source).toBe('unknown');
  });

  it('does not call the server for an empty field list', async () => {
    const source = { call: jest.fn() };

    expect(await readFieldTtls(asValkey(source), 'h', [], createHashFieldTtlContext())).toBeNull();
    expect(source.call).not.toHaveBeenCalled();
  });
});

describe('hash-field-ttl / applyFieldTtls', () => {
  function createTarget(execResult: unknown[] = [[null, 1]]) {
    const pipelineCall = jest.fn().mockReturnThis();
    const pipeline = { call: pipelineCall, exec: jest.fn().mockResolvedValue(execResult) };
    const target: MockClient = {
      call: jest.fn().mockResolvedValue(1),
      pipeline: jest.fn().mockReturnValue(pipeline),
    };
    return { target, pipelineCall, pipeline };
  }

  it('writes nothing when no field has a TTL', async () => {
    const { target } = createTarget();
    const ctx = createHashFieldTtlContext();

    expect(await applyFieldTtls(asValkey(target), 'tmp', [f1, f2], [-1, -1], ctx)).toBe(0);
    expect(target.pipeline).not.toHaveBeenCalled();
    expect(target.call).not.toHaveBeenCalled();
    expect(ctx.target).toBe('unknown');
  });

  it('groups fields with identical TTLs into one HPEXPIRE', async () => {
    const { target, pipelineCall } = createTarget([
      [null, [1, 1]],
      [null, [1]],
    ]);
    const ctx = createHashFieldTtlContext();

    const n = await applyFieldTtls(asValkey(target), 'tmp', [f1, f2, f3], [5000, 5000, 9000], ctx);

    expect(n).toBe(3);
    expect(pipelineCall).toHaveBeenCalledTimes(2);
    expect(pipelineCall).toHaveBeenCalledWith('HPEXPIRE', 'tmp', '5000', 'FIELDS', '2', f1, f2);
    expect(pipelineCall).toHaveBeenCalledWith('HPEXPIRE', 'tmp', '9000', 'FIELDS', '1', f3);
    expect(ctx.fieldsWithTtl).toBe(3);
    expect(ctx.target).toBe('supported');
  });

  it('HDELs fields that expired after they were read', async () => {
    const { target, pipelineCall } = createTarget();
    const ctx = createHashFieldTtlContext();

    const n = await applyFieldTtls(asValkey(target), 'tmp', [f1, f2], [-2, 5000], ctx);

    expect(n).toBe(1);
    expect(target.call).toHaveBeenCalledWith('HDEL', 'tmp', f1);
    expect(pipelineCall).toHaveBeenCalledWith('HPEXPIRE', 'tmp', '5000', 'FIELDS', '1', f2);
  });

  it('fails loudly when the target lacks HFE, then fails fast without a pipeline', async () => {
    const { target, pipeline } = createTarget([
      [new Error("ERR unknown command 'HPEXPIRE'"), null],
    ]);
    const ctx = createHashFieldTtlContext();

    await expect(applyFieldTtls(asValkey(target), 'tmp', [f1], [5000], ctx)).rejects.toThrow(
      '(needs Valkey 9.0+ or Redis 7.4+); 1 field TTL(s) would be lost',
    );
    expect(ctx.target).toBe('unsupported');
    expect(ctx.fieldsWithTtl).toBe(0);

    target.pipeline.mockClear();
    await expect(applyFieldTtls(asValkey(target), 'tmp', [f1], [5000], ctx)).rejects.toThrow(
      'Valkey 9.0+',
    );
    expect(target.pipeline).not.toHaveBeenCalled();
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('rethrows other target errors unchanged', async () => {
    const oom = new Error('OOM command not allowed');
    const { target } = createTarget([[oom, null]]);
    const ctx = createHashFieldTtlContext();

    await expect(applyFieldTtls(asValkey(target), 'tmp', [f1], [5000], ctx)).rejects.toBe(oom);
    expect(ctx.target).toBe('unknown');
  });
});
