# Offline & Air-Gapped Licenses

BetterDB Monitor verifies licenses with **signed entitlement tokens** (RS256 JWTs).
Every successful online license check returns a token the monitor verifies locally
against public keys embedded in the binary and persists to `data/license.jwt` — a
tamper-proof fallback that keeps your tier active for up to 7 days if
betterdb.com is unreachable.

For environments with **no internet access at all**, Pro and Enterprise customers
can download an **offline license token** and never phone home.

## Customer flow (air-gapped)

1. Sign in at [betterdb.com/account/licenses](https://www.betterdb.com/account/licenses)
   with the email your license is registered to.
2. Click **Download .jwt** (or **Copy token**) on your license. The token is valid
   until your license expires (perpetual licenses: 366 days, then re-download).
3. Transfer it to the air-gapped host however you like — it contains no secrets
   and cannot be tampered with (any modification invalidates the signature).
4. Activate it one of three ways:
   - **UI**: Settings → License → “Air-gapped environment? Activate an offline license”
     → paste or upload.
   - **Env (token)**: `BETTERDB_OFFLINE_LICENSE=eyJhbGciOiJSUzI1NiIs...`
   - **Env (file)**: `BETTERDB_OFFLINE_LICENSE_FILE=/run/secrets/betterdb-license.jwt`
     (ideal for Docker/Kubernetes secret mounts; default location is
     `data/license-offline.jwt`).

> **Persistence:** in containers, mount a volume at the persisted-state dir —
> `/app/data` by default (the container's `<workdir>/data`), or wherever you
> point `BETTERDB_DATA_DIR`. Otherwise the UI-activated offline license and the
> signed-token outage grace are lost on every restart/upgrade. **The container runs
> as UID 1001** — a freshly-mounted volume is root-owned, so persistence fails with
> `EACCES … license.jwt`. Make it writable once:
> `docker run --rm -v betterdb-data:/d alpine chown 1001:1001 /d`.

When an offline license is present and no `BETTERDB_LICENSE_KEY` is configured,
the monitor **never makes an outbound request**: license checks, telemetry, and
update pings are all disabled. The monitor logs a warning 30 days before the
token expires, an error at 7 days, and reverts to Community tier after expiry.

Offline licenses are **floating**: not bound to a machine. The `instanceLimit`
claim is displayed and logged but not hard-enforced offline.

## Verification precedence

Paid tiers require a **signed** entitlement token: an online response granting
pro/enterprise without one is refused (an unsigned grant is indistinguishable
from a spoofed `ENTITLEMENT_URL`). `LICENSE_ALLOW_UNSIGNED=true` restores the
legacy behavior for servers that cannot sign — use only during transition.

1. Fresh online check (token verified locally, then persisted)
2. In-memory cache (`LICENSE_CACHE_TTL_MS`, default 1 h)
3. Persisted signed entitlement `data/license.jwt` (valid ≤ 7 days after last check)
4. Offline license token (env string → env file path → `data/license-offline.jwt`)
5. Community tier

A light clock-rollback check (`data/license-clock.json`) warns and flags
`clockRollbackSuspected` in `GET /license/status` if the system clock moves
backwards by more than 24 h; it never denies service.

## Ops runbook (internal)

### Key generation

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out license-signing-YYYY-MM.pem
openssl pkey -in license-signing-YYYY-MM.pem -pubout   # → embed in monitor
```

- **Private key** → entitlement service secret store only:
  `LICENSE_SIGNING_PRIVATE_KEY` (PEM; real or `\n`-escaped newlines both work)
  and `LICENSE_SIGNING_KID=lic-YYYY-MM`. Never commit it (`*.pem` is gitignored).
  This keypair is deliberately separate from `AUTH_PRIVATE_KEY` so auth-key
  rotation never invalidates issued licenses.
- **Public key** → add to `proprietary/licenses/license-signing-keys.ts` keyed by
  the same kid. Public keys are safe to commit — they are what lets air-gapped
  monitors verify licenses.

### Key rotation

1. Generate the new keypair with kid `lic-YYYY-MM`.
2. Add the public key to `LICENSE_SIGNING_PUBLIC_KEYS` and **ship a monitor
   release** — monitors must know a kid before tokens signed with it appear.
3. Flip `LICENSE_SIGNING_KID` (+ private key) on the entitlement service.
4. Keep old kids in the map until the longest-lived offline token signed with
   them has expired (up to 366 days).

If a monitor sees an unknown kid it fails verification with an explicit
“upgrade BetterDB Monitor” error rather than granting a tier.

### Issuance & audit

- Online tokens: minted on every successful `POST /v1/entitlements` license
  check; `exp = min(now + 7d, license.expiresAt)`; `mode: "online"`.
- Offline tokens: `POST /admin/licenses/:id/offline-file` (admin-authed; the
  website passes the session email through and the service re-checks ownership,
  active status, Pro/Enterprise tier, and expiry);
  `exp = min(license.expiresAt, now + 366d)`; `mode: "offline"`.
- Every offline issuance is recorded in the `offline_license_issuances` table
  (jti, kid, license, email, expiry). Offline tokens are **irrevocable until
  exp** — deactivating a license stops new issuance and online checks, but an
  already-issued offline token keeps working until it expires. Size contract
  terms accordingly.

### Claims reference

```
header: { alg: "RS256", kid: "lic-YYYY-MM" }
payload: {
  iss: "betterdb-entitlement",
  sub: <license id>,        // never the raw license key
  jti: <uuid>,              // issuance id (audited for offline tokens)
  tier, features,           // features derived from tier at signing time
  customer: { name, email },
  instanceLimit,
  mode: "online" | "offline",
  iat, exp
}
```
