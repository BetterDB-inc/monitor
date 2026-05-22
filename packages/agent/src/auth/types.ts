import type { AuthMode } from '@betterdb/shared';
export type { AuthMode };

export interface AuthProvider {
  readonly mode: AuthMode;
  /**
   * Returns the AUTH password to use for the next connection attempt.
   * For static passwords this is constant. For IAM modes this returns a
   * fresh, time-limited token on every call.
   */
  getToken(): Promise<string>;
  /**
   * True when each reconnect requires regenerating the token. The Agent uses
   * this to decide between iovalkey's internal reconnect and the explicit
   * close-and-rebuild path.
   */
  readonly requiresFreshTokenPerConnection: boolean;
}
