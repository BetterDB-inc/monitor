import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sessionExplorerApi } from './session-explorer';
import { UnauthorizedError, setCurrentConnectionId } from './client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sessionExplorerApi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setCurrentConnectionId('conn-1');
  });

  afterEach(() => {
    setCurrentConnectionId(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('encodes namespace and session ids into the detail path', async () => {
    fetchMock.mockResolvedValue(json({}));
    await sessionExplorerApi.getSession('ns/1', 'chat:a b');
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /\/session-explorer\/namespaces\/ns%2F1\/sessions\/chat%3Aa%20b$/,
    );
  });

  it('posts the namespace input to the preview endpoint', async () => {
    fetchMock.mockResolvedValue(json({ sampleKey: null, view: null }));
    const input = {
      name: 'n',
      pattern: 'p:*',
      preset: 'raw' as const,
      customSchema: null,
      oversizeThresholdBytes: 1,
    };
    await sessionExplorerApi.preview(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/session-explorer\/namespaces\/preview$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it('downloads the export as a blob through an object URL', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"sessionId":"chat:1"}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="session-chat_1.json"',
        },
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:session');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const anchors: HTMLAnchorElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = create(tag);
      if (tag === 'a') anchors.push(el as HTMLAnchorElement);
      return el;
    });

    await sessionExplorerApi.exportSession('ns-1', 'chat:1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/namespaces\/ns-1\/sessions\/chat%3A1\/export$/);
    expect(init.headers['x-connection-id']).toBe('conn-1');
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchors[0].download).toBe('session-chat_1.json');
    expect(anchors[0].href).toBe('blob:session');
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:session');
  });

  it('rejects an export with the message the server sent', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Session not found' }, 404));
    await expect(sessionExplorerApi.exportSession('ns-1', 'gone')).rejects.toThrow(
      'Session not found',
    );
  });

  it('treats an unauthorised export like any other unauthorised request', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Unauthorized' }, 401));
    await expect(sessionExplorerApi.exportSession('ns-1', 'chat:1')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
