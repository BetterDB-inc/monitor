import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { agentTokensApi, type GeneratedToken, type TokenListItem } from '../../../api/agent-tokens';
import { useAuth } from '../../../contexts/AuthContext';
import { useMcpTokens } from '../../../hooks/useMcpTokens';

const COPIED_RESET_MS = 2000;

type TokenStatus = 'revoked' | 'expired' | 'active';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function tokenStatus(token: TokenListItem, now: number): TokenStatus {
  if (token.revokedAt !== null) {
    return 'revoked';
  }
  if (token.expiresAt <= now) {
    return 'expired';
  }
  return 'active';
}

function clientConfig(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        betterdb: {
          type: 'stdio',
          command: 'npx',
          args: ['@betterdb/mcp'],
          env: { BETTERDB_URL: window.location.origin, BETTERDB_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

export function McpTokensPanel(): ReactElement {
  const { user, isCloud } = useAuth();
  const { tokens, invalidate } = useMcpTokens(true);
  const [name, setName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmedName = name.trim();
  const now = Date.now();

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const handleGenerate = async (): Promise<void> => {
    if (trimmedName.length === 0) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const result = await agentTokensApi.generate(trimmedName, 'mcp');
      setGenerated(result);
      setCopied(false);
      setCopyFailed(false);
      setName('');
      await invalidate();
    } catch (err) {
      setError(errorMessage(err, 'Failed to generate token'));
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (id: string): Promise<void> => {
    setError(null);
    try {
      await agentTokensApi.revoke(id);
      await invalidate();
    } catch (err) {
      setError(errorMessage(err, 'Failed to revoke token'));
    }
  };

  const handleCopy = async (text: string): Promise<void> => {
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    if (navigator.clipboard === undefined) {
      tokenInputRef.current?.select();
      setCopied(false);
      setCopyFailed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailed(false);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, COPIED_RESET_MS);
    } catch {
      tokenInputRef.current?.select();
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      void handleGenerate();
    }
  };

  const ownerLabel = (token: TokenListItem): string | null => {
    if (token.userId === undefined) {
      return null;
    }
    if (token.userId === null) {
      return 'Owner: none';
    }
    if (user !== null && token.userId === user.userId) {
      return null;
    }
    if (typeof token.ownerEmail === 'string') {
      return `Owner: ${token.ownerEmail}`;
    }
    return 'Owner: removed member';
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold mb-4">MCP Tokens</h2>
      <p className="text-sm text-muted-foreground">
        Generate tokens for MCP (Model Context Protocol) clients like Claude Code to access your
        database observability data.
      </p>
      {isCloud === false && (
        <p className="text-sm text-muted-foreground">
          A token acts as you: calls made with it can do only what your role allows, and changes
          made with it are recorded under your name in the activity log. It cannot invite or change
          members, or manage tokens. MCP reads also work without a token.
        </p>
      )}

      {error !== null && (
        <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
          {error}
        </div>
      )}

      {generated === null && (
        <div>
          <label className="block text-sm font-medium mb-1">Generate MCP Token</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="Token name (e.g., claude-code)"
              className="flex-1 px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              onKeyDown={handleNameKeyDown}
            />
            <button
              onClick={() => {
                void handleGenerate();
              }}
              disabled={generating === true || trimmedName.length === 0}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
              {generating === true ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {generated !== null && (
        <div className="border rounded-md p-3 bg-amber-50 border-amber-300">
          <h3 className="text-sm font-medium text-amber-700 mb-2">
            Save this token - it won't be shown again
          </h3>
          <div className="flex gap-2 mb-3">
            <input
              ref={tokenInputRef}
              aria-label="MCP token"
              readOnly
              value={generated.token}
              className="flex-1 text-xs bg-white dark:text-gray-900 p-2 rounded border font-mono"
            />
            <button
              onClick={() => {
                void handleCopy(generated.token);
              }}
              className="px-3 py-1 text-xs border rounded hover:bg-muted flex-shrink-0"
            >
              {copied === true ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {copyFailed === true && (
            <p className="text-xs text-destructive mb-3">
              Copy failed. Select the token and copy it manually.
            </p>
          )}
          <h4 className="text-xs font-medium mb-1">Add to your Claude Code MCP config:</h4>
          <pre className="text-xs bg-white dark:text-gray-900 p-2 rounded border overflow-x-auto">
            {clientConfig(generated.token)}
          </pre>
          <button
            onClick={() => {
              setGenerated(null);
            }}
            className="mt-3 text-xs text-primary hover:underline"
          >
            I've saved the token
          </button>
        </div>
      )}

      {tokens.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Existing Tokens</h3>
          <div className="space-y-1">
            {tokens.map((token) => {
              const status = tokenStatus(token, now);
              const owner = ownerLabel(token);
              return (
                <div
                  key={token.id}
                  className="flex items-center justify-between p-2 border rounded-md text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{token.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {`Created ${new Date(token.createdAt).toLocaleDateString()}`}
                      {token.lastUsedAt !== null &&
                        ` · Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                    </div>
                    {owner !== null && <div className="text-xs text-muted-foreground">{owner}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {status === 'revoked' && (
                      <span className="text-xs px-1.5 py-0.5 bg-destructive/10 text-destructive rounded">
                        Revoked
                      </span>
                    )}
                    {status === 'expired' && (
                      <span className="text-xs px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                        Expired
                      </span>
                    )}
                    {status === 'active' && (
                      <>
                        <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                          Active
                        </span>
                        <button
                          onClick={() => {
                            void handleRevoke(token.id);
                          }}
                          className="text-xs px-2 py-1 border border-destructive/20 text-destructive rounded hover:bg-destructive/10"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
