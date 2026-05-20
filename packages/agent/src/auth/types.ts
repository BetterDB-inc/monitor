/**
 * AuthMode controls how the agent obtains the AUTH password for its Valkey/Redis
 * client. "password" returns the static password from config. IAM modes generate
 * short-lived SigV4-signed tokens and require fresh generation per reconnect.
 */
export type AuthMode = 'password' | 'elasticache-iam';

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
