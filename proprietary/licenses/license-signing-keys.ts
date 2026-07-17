/**
 * Public keys for verifying signed license/entitlement tokens, keyed by the
 * `kid` JWT header the entitlement server stamps on every token.
 *
 * Rotation: add the new public key here and ship a release BEFORE flipping
 * LICENSE_SIGNING_KID on the entitlement server. Old kids stay until the
 * longest-lived offline token signed with them has expired (up to 366 days).
 *
 * These are public keys — committing them is safe and required: they are what
 * lets an air-gapped monitor verify a license with zero network access.
 */
export const LICENSE_SIGNING_PUBLIC_KEYS: Record<string, string> = {
  'lic-2026-01': `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2NLUmenXDZKNYNZG8Ozz
dRsNXs3SsTPNPnLW8ptrhcS0RdXFhoNXdLDX8/N/FST4wLNCOjkjcD5gf2BRKP8R
AE3sWwo7ogyNov2S3UI3c8nFcqIHpmhEnUvGfqLz9ZLV2vut5nOZodxCffFdhd/i
y0pg2PMW8n9JZNyXsigYxalbHIsSS8MfFaWNgYlO6bgx6u4Pfq+YTL/SoFjErZSW
EtZFlCz7ugaTjt86170m4J2bXTkowYObcJrmXWKboOSBzXt1bx0smhEryfCyzYl9
hWCt1MHnm1tCfMjKDsBLZGAxXRyCHLhTMdBnG7TO51FxOr6q/X/RegyXBNGI4QkV
XwIDAQAB
-----END PUBLIC KEY-----`,
};
