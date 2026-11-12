/**
 * A server reply refusing the credentials or the ACL user's permissions. The
 * code is matched at the start of the reply, or after a `: ` where a caller
 * prefixed it, never anywhere in the message: messages carry host names, and
 * `redis-noauth-0` must not read as NOAUTH.
 */
const AUTH_REPLY =
  /(?:^|: )(?:(?:WRONGPASS|NOAUTH|NOPERM)\b|ERR (?:invalid password|AUTH\b|Client sent AUTH|invalid username-password))/;

export function isAuthErrorReply(message: string): boolean {
  return AUTH_REPLY.test(message);
}
