import { describe, it, expect, vi, type Mock } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import { EmbeddingError, ValkeyCommandError } from '../errors';
import { encodeFloat32, escapeTag, parseFtSearchResponse } from '../utils';
import type { EmbedFn, Valkey } from '../types';

type CallFn = (...args: unknown[]) => Promise<unknown>;

interface MockClient {
  call: Mock<CallFn>;
  hset: Mock<(...args: unknown[]) => Promise<number>>;
  hgetall: Mock<(key: string) => Promise<Record<string, string>>>;
  hincrby: Mock<(...args: unknown[]) => Promise<number>>;
  expire: Mock<(...args: unknown[]) => Promise<number>>;
  del: Mock<(...args: unknown[]) => Promise<number>>;
  scan: Mock<(...args: unknown[]) => Promise<[string, string[]]>>;
  get: Mock<(key: string) => Promise<string | null>>;
  getBuffer: Mock<(key: string) => Promise<Buffer | null>>;
  set: Mock<(...args: unknown[]) => Promise<string>>;
  pipeline: Mock<() => Record<string, Mock>>;
  zadd: Mock<(...args: unknown[]) => Promise<number>>;
  zrange: Mock<(...args: unknown[]) => Promise<string[]>>;
  nodes: Mock<() => null>;
}

function makeClient(callImpl: CallFn): MockClient {
  return {
    call: vi.fn(callImpl),
    hset: vi.fn(async (..._args: unknown[]) => {
      return 1;
    }),
    hgetall: vi.fn(async (_key: string) => {
      return {};
    }),
    hincrby: vi.fn(async (..._args: unknown[]) => {
      return 1;
    }),
    expire: vi.fn(async (..._args: unknown[]) => {
      return 1;
    }),
    del: vi.fn(async (..._args: unknown[]) => {
      return 1;
    }),
    scan: vi.fn(async (..._args: unknown[]): Promise<[string, string[]]> => {
      return ['0', []];
    }),
    get: vi.fn(async (_key: string) => {
      return null;
    }),
    getBuffer: vi.fn(async (_key: string) => {
      return null;
    }),
    set: vi.fn(async (..._args: unknown[]) => {
      return 'OK';
    }),
    pipeline: vi.fn(() => {
      return {
        hincrby: vi.fn().mockReturnThis(),
        call: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zremrangebyscore: vi.fn().mockReturnThis(),
        zremrangebyrank: vi.fn().mockReturnThis(),
        exec: vi.fn(async () => {
          return [];
        }),
      };
    }),
    zadd: vi.fn(async (..._args: unknown[]) => {
      return 1;
    }),
    zrange: vi.fn(async (..._args: unknown[]) => {
      return [];
    }),
    nodes: vi.fn(() => {
      return null;
    }),
  };
}

function makeCache(client: MockClient, embedFn: EmbedFn, name: string): SemanticCache {
  return new SemanticCache({
    client: client as unknown as Valkey,
    embedFn,
    name,
    discovery: { enabled: false },
    configRefresh: { enabled: false },
  });
}

function defaultEmbedFn(): Mock<EmbedFn> {
  return vi.fn(async (_text: string) => {
    return [0.1, 0.2, 0.3];
  });
}

function ftDispatch(handlers: Record<string, CallFn>): CallFn {
  return async (...args: unknown[]): Promise<unknown> => {
    const cmd = String(args[0]);
    const handler = handlers[cmd];
    if (handler !== undefined) {
      return handler(...args);
    }
    return null;
  };
}

function callsFor(client: MockClient, command: string): unknown[][] {
  return client.call.mock.calls.filter((args) => {
    return args[0] === command;
  });
}

const INFO_DIM3_WITH_BINARY_REFS: unknown[] = [
  'attributes',
  [
    ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '3']],
    ['identifier', 'binary_refs'],
  ],
];

const INFO_DIM3_NO_BINARY_REFS: unknown[] = [
  'attributes',
  [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '3']]],
];

describe('encodeFloat32 byte layout', () => {
  it('encodes 1.0 as little-endian IEEE-754 float32 00 00 80 3f', () => {
    expect(encodeFloat32([1.0])).toEqual(Buffer.from([0x00, 0x00, 0x80, 0x3f]));
  });

  it('encodes -2.0 as 00 00 00 c0', () => {
    expect(encodeFloat32([-2.0])).toEqual(Buffer.from([0x00, 0x00, 0x00, 0xc0]));
  });

  it('concatenates elements in order, 4 bytes each', () => {
    expect(encodeFloat32([0.5, 1.5])).toEqual(
      Buffer.from([0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xc0, 0x3f]),
    );
  });

  it('returns an empty buffer for an empty vector', () => {
    expect(encodeFloat32([]).byteLength).toBe(0);
  });
});

describe('escapeTag', () => {
  it('backslash-escapes dashes', () => {
    expect(escapeTag('gpt-4o')).toBe('gpt\\-4o');
  });

  it('backslash-escapes spaces', () => {
    expect(escapeTag('hello world')).toBe('hello\\ world');
  });

  it('backslash-escapes punctuation set including comma, dot, slash, backslash', () => {
    expect(escapeTag('a,b.c/d\\e')).toBe('a\\,b\\.c\\/d\\\\e');
  });

  it('backslash-escapes braces, brackets, quotes, and shell-ish symbols', () => {
    expect(escapeTag('{x}[y]"z"\'w\'')).toBe('\\{x\\}\\[y\\]\\"z\\"\\\'w\\\'');
    expect(escapeTag('!@#$%^&*()+=~|<>:;')).toBe(
      '\\!\\@\\#\\$\\%\\^\\&\\*\\(\\)\\+\\=\\~\\|\\<\\>\\:\\;',
    );
  });

  it('leaves alphanumerics and underscores untouched', () => {
    expect(escapeTag('abc_DEF_123')).toBe('abc_DEF_123');
  });

  it('does NOT escape question mark or backtick (characterized gap)', () => {
    expect(escapeTag('x?y`z')).toBe('x?y`z');
  });
});

describe('parseFtSearchResponse edge shapes', () => {
  it('accepts a numeric (non-string) total count', () => {
    const result = parseFtSearchResponse([1, 'key:a', ['f', 'v']]);
    expect(result).toEqual([{ key: 'key:a', fields: { f: 'v' } }]);
  });

  it('returns [] when total count is a non-numeric string', () => {
    expect(parseFtSearchResponse(['abc', 'key:a', ['f', 'v']])).toEqual([]);
  });

  it('returns [] for a negative total count', () => {
    expect(parseFtSearchResponse(['-1'])).toEqual([]);
  });

  it('returns [] when raw is not an array', () => {
    expect(parseFtSearchResponse('1')).toEqual([]);
    expect(parseFtSearchResponse(undefined)).toEqual([]);
  });

  it('parses RETURN 0 mode (keys with no field lists) into entries with empty fields', () => {
    const result = parseFtSearchResponse(['2', 'key:a', 'key:b']);
    expect(result).toEqual([
      { key: 'key:a', fields: {} },
      { key: 'key:b', fields: {} },
    ]);
  });

  it('skips non-string keys, which also orphans their field list', () => {
    expect(parseFtSearchResponse(['1', 42, ['f', 'v']])).toEqual([]);
  });

  it('does not trust the total count over the actual rows present', () => {
    const result = parseFtSearchResponse(['5', 'key:a', ['f', 'v']]);
    expect(result).toHaveLength(1);
  });
});

describe('initialize: FT.INFO existing-index path', () => {
  it('parses dimension from the Valkey Search 1.2 nested index sub-array without probing', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return INFO_DIM3_WITH_BINARY_REFS;
        },
      }),
    );
    const embedFn = defaultEmbedFn();
    const cache = makeCache(client, embedFn, 'ftchar');

    await cache.initialize();

    expect(callsFor(client, 'FT.CREATE')).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
    const info = await cache.indexInfo();
    expect(info.dimension).toBe(3);
  });

  it('parses dimension from a flat DIM attribute pair (pre-1.2 shape)', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return ['attributes', [['identifier', 'embedding', 'type', 'VECTOR', 'DIM', '3']]];
        },
      }),
    );
    const embedFn = defaultEmbedFn();
    const cache = makeCache(client, embedFn, 'ftchar');

    await cache.initialize();

    expect(callsFor(client, 'FT.CREATE')).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('falls back to a probe embedding when the existing index dimension is unparsable', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return ['attributes', [['identifier', 'embedding', 'type', 'VECTOR']]];
        },
      }),
    );
    const embedFn = vi.fn(async (_text: string) => {
      return [0.1, 0.2, 0.3, 0.4, 0.5];
    });
    const cache = makeCache(client, embedFn, 'ftchar');

    await cache.initialize();

    expect(callsFor(client, 'FT.CREATE')).toHaveLength(0);
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith('probe');
    const info = await cache.indexInfo();
    expect(info.dimension).toBe(5);
  });

  it('rethrows a probe EmbeddingError unwrapped (not as ValkeyCommandError)', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return ['attributes', [['identifier', 'embedding', 'type', 'VECTOR']]];
        },
      }),
    );
    const embedFn = vi.fn(async (_text: string): Promise<number[]> => {
      throw new Error('provider down');
    });
    const cache = makeCache(client, embedFn, 'ftchar');

    const err = await cache.initialize().catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).message).toBe('embedFn failed: provider down');
  });
});

describe('initialize: FT.CREATE missing-index path', () => {
  function missingIndexClient(message: string): MockClient {
    return makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          throw new Error(message);
        },
        'FT.CREATE': async () => {
          return 'OK';
        },
      }),
    );
  }

  it('issues FT.CREATE with the exact ON HASH / PREFIX / SCHEMA argument vector', async () => {
    const client = missingIndexClient('Unknown index name');
    const embedFn = defaultEmbedFn();
    const cache = makeCache(client, embedFn, 'ftchar');

    await cache.initialize();

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith('probe');
    const createCalls = callsFor(client, 'FT.CREATE');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual([
      'FT.CREATE',
      'ftchar:idx',
      'ON',
      'HASH',
      'PREFIX',
      '1',
      'ftchar:entry:',
      'SCHEMA',
      'prompt',
      'TEXT',
      'NOSTEM',
      'response',
      'TEXT',
      'NOSTEM',
      'model',
      'TAG',
      'category',
      'TAG',
      'binary_refs',
      'TAG',
      'inserted_at',
      'NUMERIC',
      'SORTABLE',
      'temperature',
      'NUMERIC',
      'top_p',
      'NUMERIC',
      'seed',
      'NUMERIC',
      'embedding',
      'VECTOR',
      'HNSW',
      '6',
      'TYPE',
      'FLOAT32',
      'DIM',
      '3',
      'DISTANCE_METRIC',
      'COSINE',
    ]);
  });

  it('treats "no such index" as index-missing', async () => {
    const client = missingIndexClient('no such index');
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();
    expect(callsFor(client, 'FT.CREATE')).toHaveLength(1);
  });

  it('treats any message containing "not found" as index-missing (characterized broad match)', async () => {
    const client = missingIndexClient('something was not found somewhere');
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();
    expect(callsFor(client, 'FT.CREATE')).toHaveLength(1);
  });

  it('matches index-missing messages case-insensitively', async () => {
    const client = missingIndexClient('UNKNOWN INDEX NAME ftchar:idx');
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();
    expect(callsFor(client, 'FT.CREATE')).toHaveLength(1);
  });

  it('wraps unrecognized FT.INFO errors as ValkeyCommandError("FT.INFO", ...)', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          throw new Error('LOADING Valkey is loading the dataset in memory');
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');

    const err = await cache.initialize().catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(ValkeyCommandError);
    expect((err as ValkeyCommandError).name).toBe('ValkeyCommandError');
    expect((err as ValkeyCommandError).command).toBe('FT.INFO');
    expect((err as ValkeyCommandError).message).toBe(
      "Valkey command 'FT.INFO' failed: LOADING Valkey is loading the dataset in memory",
    );
    expect(callsFor(client, 'FT.CREATE')).toHaveLength(0);
  });

  it('wraps an absent search module ("unknown command") as ValkeyCommandError, not index-missing', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          throw new Error("ERR unknown command 'FT.INFO'");
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');

    const err = await cache.initialize().catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(ValkeyCommandError);
    expect((err as ValkeyCommandError).command).toBe('FT.INFO');
    expect(callsFor(client, 'FT.CREATE')).toHaveLength(0);
  });

  it('wraps non-Error throwables (message lookup yields empty string, never index-missing)', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          throw 'not found';
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');

    const err = await cache.initialize().catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(ValkeyCommandError);
    expect((err as ValkeyCommandError).message).toBe("Valkey command 'FT.INFO' failed: not found");
  });
});

describe('check(): FT.SEARCH invocation shape', () => {
  async function initializedCache(
    info: unknown[],
    searchReply: unknown,
  ): Promise<{ cache: SemanticCache; client: MockClient }> {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return info;
        },
        'FT.SEARCH': async () => {
          return searchReply;
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();
    return { cache, client };
  }

  it('issues KNN query with PARAMS vec buffer, LIMIT 0 k, DIALECT 2', async () => {
    const { cache, client } = await initializedCache(INFO_DIM3_WITH_BINARY_REFS, ['0']);

    await cache.check('hello');

    const searchCalls = callsFor(client, 'FT.SEARCH');
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toEqual([
      'FT.SEARCH',
      'ftchar:idx',
      '*=>[KNN 1 @embedding $vec AS __score]',
      'PARAMS',
      '2',
      'vec',
      encodeFloat32([0.1, 0.2, 0.3]),
      'LIMIT',
      '0',
      '1',
      'DIALECT',
      '2',
    ]);
  });

  it('wraps a user filter in parentheses and applies k to both KNN and LIMIT', async () => {
    const { cache, client } = await initializedCache(INFO_DIM3_WITH_BINARY_REFS, ['0']);

    await cache.check('hello', { filter: '@category:{faq}', k: 3 });

    const [args] = callsFor(client, 'FT.SEARCH');
    expect(args[2]).toBe('(@category:{faq})=>[KNN 3 @embedding $vec AS __score]');
    expect(args.slice(7)).toEqual(['LIMIT', '0', '3', 'DIALECT', '2']);
  });

  it('adds an escaped @binary_refs TAG clause per ref when the schema has binary_refs', async () => {
    const { cache, client } = await initializedCache(INFO_DIM3_WITH_BINARY_REFS, ['0']);

    await cache.check([
      { type: 'text', text: 'what is this image' },
      { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'img-1' },
    ]);

    const [args] = callsFor(client, 'FT.SEARCH');
    expect(args[2]).toBe('(@binary_refs:{img\\-1})=>[KNN 1 @embedding $vec AS __score]');
  });

  it('AND-chains multiple binary refs in sorted order after a user filter', async () => {
    const { cache, client } = await initializedCache(INFO_DIM3_WITH_BINARY_REFS, ['0']);

    await cache.check(
      [
        { type: 'text', text: 'compare' },
        { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'b.png' },
        { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'a.png' },
      ],
      { filter: '@category:{faq}' },
    );

    const [args] = callsFor(client, 'FT.SEARCH');
    expect(args[2]).toBe(
      '(@category:{faq} @binary_refs:{a\\.png} @binary_refs:{b\\.png})' +
        '=>[KNN 1 @embedding $vec AS __score]',
    );
  });

  it('omits the binary_refs clause when the index schema lacks binary_refs', async () => {
    const { cache, client } = await initializedCache(INFO_DIM3_NO_BINARY_REFS, ['0']);

    await cache.check([
      { type: 'text', text: 'what is this image' },
      { type: 'binary', kind: 'image', mediaType: 'image/png', ref: 'img-1' },
    ]);

    const [args] = callsFor(client, 'FT.SEARCH');
    expect(args[2]).toBe('*=>[KNN 1 @embedding $vec AS __score]');
  });

  it('wraps FT.SEARCH failures as ValkeyCommandError("FT.SEARCH", ...)', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return INFO_DIM3_WITH_BINARY_REFS;
        },
        'FT.SEARCH': async () => {
          throw new Error("ERR unknown command 'FT.SEARCH'");
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();

    const err = await cache.check('hello').catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(ValkeyCommandError);
    expect((err as ValkeyCommandError).command).toBe('FT.SEARCH');
    expect((err as ValkeyCommandError).message).toBe(
      "Valkey command 'FT.SEARCH' failed: ERR unknown command 'FT.SEARCH'",
    );
  });
});

describe('store(): embedding bytes written to the hash', () => {
  it('writes the embedding field as the little-endian float32 buffer', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return INFO_DIM3_WITH_BINARY_REFS;
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();

    const key = await cache.store('question', 'answer');

    expect(key.startsWith('ftchar:entry:')).toBe(true);
    const [hsetKey, fields] = client.hset.mock.calls[0] as [string, Record<string, unknown>];
    expect(hsetKey).toBe(key);
    expect(fields['embedding']).toEqual(encodeFloat32([0.1, 0.2, 0.3]));
  });
});

describe('invalidate(): FT.SEARCH RETURN 0 shape', () => {
  it('passes the filter verbatim with RETURN 0, LIMIT 0 1000, DIALECT 2', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return INFO_DIM3_WITH_BINARY_REFS;
        },
        'FT.SEARCH': async () => {
          return ['0'];
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();

    const result = await cache.invalidate('@model:{gpt\\-4o}');

    expect(result).toEqual({ deleted: 0, truncated: false });
    const [args] = callsFor(client, 'FT.SEARCH');
    expect(args).toEqual([
      'FT.SEARCH',
      'ftchar:idx',
      '@model:{gpt\\-4o}',
      'RETURN',
      '0',
      'LIMIT',
      '0',
      '1000',
      'DIALECT',
      '2',
    ]);
  });
});

describe('flush(): FT.DROPINDEX path', () => {
  it('issues FT.DROPINDEX with only the index name and tolerates index-missing errors', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.DROPINDEX': async () => {
          throw new Error('Unknown index name ftchar:idx');
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');

    await cache.flush();

    const dropCalls = callsFor(client, 'FT.DROPINDEX');
    expect(dropCalls).toEqual([['FT.DROPINDEX', 'ftchar:idx']]);
    expect(client.del).toHaveBeenCalledWith('ftchar:__stats');
    expect(client.del).toHaveBeenCalledWith('ftchar:__similarity_window');
  });

  it('wraps other FT.DROPINDEX failures as ValkeyCommandError("FT.DROPINDEX", ...)', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.DROPINDEX': async () => {
          throw new Error('ERR some unrelated failure');
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');

    const err = await cache.flush().catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(ValkeyCommandError);
    expect((err as ValkeyCommandError).command).toBe('FT.DROPINDEX');
    expect((err as ValkeyCommandError).message).toBe(
      "Valkey command 'FT.DROPINDEX' failed: ERR some unrelated failure",
    );
  });
});

describe('indexInfo(): FT.INFO stats path', () => {
  it('parses num_docs and indexing from the flat key/value reply', async () => {
    const infoReply: unknown[] = ['num_docs', '42', 'indexing', '1', ...INFO_DIM3_WITH_BINARY_REFS];
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return infoReply;
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();

    const info = await cache.indexInfo();

    expect(info).toEqual({
      name: 'ftchar:idx',
      numDocs: 42,
      dimension: 3,
      indexingState: '1',
    });
  });

  it('defaults numDocs to 0 and indexingState to "unknown" when keys are absent', async () => {
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          return INFO_DIM3_WITH_BINARY_REFS;
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();

    const info = await cache.indexInfo();

    expect(info.numDocs).toBe(0);
    expect(info.indexingState).toBe('unknown');
  });

  it('wraps FT.INFO failures as ValkeyCommandError("FT.INFO", ...) even after initialize', async () => {
    let initialized = false;
    const client = makeClient(
      ftDispatch({
        'FT.INFO': async () => {
          if (initialized === false) {
            return INFO_DIM3_WITH_BINARY_REFS;
          }
          throw new Error('connection reset');
        },
      }),
    );
    const cache = makeCache(client, defaultEmbedFn(), 'ftchar');
    await cache.initialize();
    initialized = true;

    const err = await cache.indexInfo().catch((e: unknown) => {
      return e;
    });
    expect(err).toBeInstanceOf(ValkeyCommandError);
    expect((err as ValkeyCommandError).command).toBe('FT.INFO');
  });
});
