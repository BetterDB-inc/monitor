import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { compare, valid as validSemver } from 'semver';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Tier, Feature, TIER_FEATURES, EntitlementResponse, EntitlementRequest } from './types';
import type { LicenseSource, LicenseTokenClaims } from './types';
import type { VersionInfo } from '@betterdb/shared';
import { TelemetryPort } from '@app/common/interfaces/telemetry-port.interface';
import { verifyLicenseToken, claimsToEntitlement, LicenseTokenError } from './license-token.verifier';

// Default persisted-state dir: <cwd>/data — a predictable, mountable path
// (/app/data in the container image, WORKDIR /app) rather than the build-output
// location __dirname would resolve to (apps/api/dist/data), which operators
// can't reasonably mount. The actual dir is resolved in the constructor from
// BETTERDB_DATA_DIR (honoring a .env value loaded before construction). In
// containers this MUST be a mounted volume for the signed-token grace and a
// UI-activated offline license to survive restarts/upgrades.
const DEFAULT_DATA_DIR = join(process.cwd(), 'data');

const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const OFFLINE_EXPIRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OFFLINE_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000;
const OFFLINE_EXPIRY_ERROR_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedEntitlement {
  response: EntitlementResponse;
  cachedAt: number;
}

/**
 * The server granted a paid tier WITHOUT a signed token (legacy server, or
 * signing broken server-side). Unlike a rejection this says nothing about the
 * license itself, so it degrades like an outage: the persisted signed
 * fallback keeps its grace window.
 */
export class UnsignedEntitlementError extends Error {}

@Injectable()
export class LicenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenseService.name);
  // Persisted-state paths, resolved from BETTERDB_DATA_DIR in the constructor.
  private readonly dataDir: string;
  private readonly licenseKeyFile: string;
  private readonly licenseJwtFile: string;
  private readonly offlineLicenseFile: string;
  private readonly clockFile: string;
  private licenseKey: string | null;
  private readonly entitlementUrl: string;
  private readonly allowUnsigned: boolean;
  private readonly cacheTtlMs: number;
  private readonly maxStaleCacheMs: number;
  private readonly timeoutMs: number;
  private readonly instanceId: string;
  private telemetryEnabled: boolean;
  private readonly versionCheckIntervalMs: number;

  private cache: CachedEntitlement | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private offlineExpiryTimer: ReturnType<typeof setInterval> | null = null;
  public validationPromise: Promise<EntitlementResponse> | null = null;
  private isValidated = false;

  // Signed-token state
  private source: LicenseSource = 'community';
  private verifiedClaims: LicenseTokenClaims | null = null;
  private offlineClaims: LicenseTokenClaims | null = null;
  private airGapped = false;
  private clockRollbackSuspected = false;
  private warnedTokenlessServer = false;
  // Bumped on every activation/mode transition so in-flight validations
  // (which may resolve AFTER a transition) can detect they are stale and
  // must not overwrite the new state.
  private stateEpoch = 0;

  // Version check state
  private readonly currentVersion: string;
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private versionCheckedAt: number | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject('TELEMETRY_CLIENT') @Optional() private readonly telemetryClient?: TelemetryPort,
  ) {
    this.currentVersion =
      process.env.APP_VERSION || process.env.npm_package_version || 'unknown';

    // Resolve persisted-state paths first — loadPersistedKey() below reads one.
    this.dataDir = process.env.BETTERDB_DATA_DIR || DEFAULT_DATA_DIR;
    this.licenseKeyFile = join(this.dataDir, 'license.key');
    this.licenseJwtFile = join(this.dataDir, 'license.jwt');
    this.offlineLicenseFile = join(this.dataDir, 'license-offline.jwt');
    this.clockFile = join(this.dataDir, 'license-clock.json');

    this.licenseKey = process.env.BETTERDB_LICENSE_KEY || this.loadPersistedKey();
    // Use the canonical www host directly: the apex betterdb.com 307-redirects
    // to www, and Node's fetch doesn't always preserve POST bodies across
    // cross-host redirects, which would silently break license validation.
    this.entitlementUrl = process.env.ENTITLEMENT_URL || 'https://www.betterdb.com/api/v1/entitlements';
    this.cacheTtlMs = parseInt(process.env.LICENSE_CACHE_TTL_MS || '3600000', 10);
    this.maxStaleCacheMs = parseInt(process.env.LICENSE_MAX_STALE_MS || '604800000', 10);
    this.timeoutMs = parseInt(process.env.LICENSE_TIMEOUT_MS || '10000', 10);
    this.instanceId = this.generateInstanceId();
    this.telemetryEnabled = process.env.BETTERDB_TELEMETRY !== 'false';
    this.versionCheckIntervalMs = this.config.get<number>('VERSION_CHECK_INTERVAL_MS') || 3600000;
    // Escape hatch for legacy entitlement servers that don't sign responses.
    // Off by default: an unsigned response granting a paid tier is
    // indistinguishable from a spoofed ENTITLEMENT_URL.
    this.allowUnsigned = process.env.LICENSE_ALLOW_UNSIGNED === 'true';

    // Resolve air-gapped state HERE, in the constructor — it runs before any
    // dependent provider's onModuleInit (e.g. UsageTelemetryService), so
    // telemetry is force-disabled before anything can fire identify/app_start.
    // Relying on onModuleInit ordering left a boot window where an air-gapped
    // instance still phoned home. onModuleInit does the rest (cache, timers).
    this.loadOfflineLicense();
    if (this.offlineClaims && !this.licenseKey) {
      this.airGapped = true;
      this.telemetryEnabled = false;
    }
  }

  private generateInstanceId(): string {
    // Use infrastructure identifiers only - avoid including license key to prevent fingerprinting
    const dbHost = process.env.DB_HOST || '';
    const dbPort = process.env.DB_PORT || '';
    const storageUrl = process.env.STORAGE_URL || '';
    const hostname = process.env.HOSTNAME || '';

    const input = `${dbHost}|${dbPort}|${storageUrl}|${hostname}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  async onModuleInit() {
    // Always log current version on startup
    this.logger.log(`BetterDB Monitor v${this.currentVersion}`);

    this.checkClockRollback();
    // Offline license already loaded in the constructor (so telemetry was
    // disabled early). Fully air-gapped when there's no key: the token is the
    // sole authority and the instance never phones home.
    if (this.offlineClaims && !this.licenseKey) {
      this.enterAirGappedMode();
      return;
    }

    // Always validate entitlements on startup, regardless of license key presence
    // in order to enable beta features for keyless instances.
    if (!this.licenseKey) {
      this.logger.log('No license key provided, checking entitlements for Community tier...');
    } else {
      this.logger.log('Starting license validation in background...');
    }
    this.validationPromise = this.validateLicenseBackground();

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    // Gate on air-gapped, NOT telemetry: periodic license re-validation must
    // keep running even when BETTERDB_TELEMETRY=false (otherwise a lapsed
    // subscription keeps serving paid features until restart). Only the
    // telemetry ping is suppressed when telemetry is off. Air-gapped instances
    // never start this timer (no phone-home).
    if (this.heartbeatTimer || this.airGapped) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.telemetryEnabled) {
        this.collectStats().then(stats => {
          this.sendHeartbeat(stats);
        });
      }
      this.validateLicense().catch(() => {
        // Re-validation is best-effort
      });
      this.persistClock();
    }, this.versionCheckIntervalMs);
    this.logger.log(`License re-validation scheduled every ${this.versionCheckIntervalMs}ms`);
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.offlineExpiryTimer) {
      clearInterval(this.offlineExpiryTimer);
      this.offlineExpiryTimer = null;
    }
  }

  /**
   * Load and verify an offline license token, if one is configured, from (in
   * priority order): BETTERDB_OFFLINE_LICENSE (the token itself),
   * BETTERDB_OFFLINE_LICENSE_FILE (a path), then data/license-offline.jwt.
   * A missing/unreadable/invalid candidate falls through to the next one.
   */
  private loadOfflineLicense(): void {
    const envToken = (process.env.BETTERDB_OFFLINE_LICENSE || '').trim();
    if (envToken && this.adoptOfflineToken(envToken, 'BETTERDB_OFFLINE_LICENSE')) {
      return;
    }

    const candidates: Array<{ path: string; explicit: boolean }> = [];
    if (process.env.BETTERDB_OFFLINE_LICENSE_FILE) {
      candidates.push({ path: process.env.BETTERDB_OFFLINE_LICENSE_FILE, explicit: true });
    }
    candidates.push({ path: this.offlineLicenseFile, explicit: false });

    for (const { path, explicit } of candidates) {
      let token: string;
      try {
        token = readFileSync(path, 'utf-8').trim();
      } catch {
        if (explicit) {
          // An explicitly configured path that can't be read deserves a
          // warning, not silence — but the default location still gets tried.
          this.logger.warn(`BETTERDB_OFFLINE_LICENSE_FILE is set but ${path} could not be read`);
        }
        continue;
      }
      if (token && this.adoptOfflineToken(token, path)) {
        return;
      }
    }
  }

  private adoptOfflineToken(token: string, sourceDesc: string): boolean {
    try {
      const claims = verifyLicenseToken(token);
      if (claims.mode !== 'offline') {
        this.logger.warn(`Ignoring license token from ${sourceDesc}: not an offline license token`);
        return false;
      }
      this.offlineClaims = claims;
      this.logger.log(
        `Offline license loaded (${claims.tier}, expires ${new Date(claims.exp * 1000).toISOString()})`,
      );
      return true;
    } catch (error) {
      this.logger.error(`Offline license from ${sourceDesc} rejected: ${(error as Error).message}`);
      return false;
    }
  }

  private enterAirGappedMode(): void {
    this.stateEpoch++;
    const response = claimsToEntitlement(this.offlineClaims!);
    this.cache = { response, cachedAt: Date.now() };
    this.source = 'offline-token';
    this.verifiedClaims = this.offlineClaims;
    this.isValidated = true;
    this.validationPromise = Promise.resolve(response);
    this.telemetryEnabled = false;
    this.airGapped = true;

    // Runtime activation (UI paste) can happen with the heartbeat already
    // running — air-gapped mode means it must stop.
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.offlineExpiryTimer) {
      clearInterval(this.offlineExpiryTimer);
    }

    this.logger.log(
      `Running from offline license (${response.tier}, floating, up to ${this.offlineClaims!.instanceLimit} instances) — telemetry and phone-home disabled`,
    );
    this.warnOfflineExpiry();

    this.offlineExpiryTimer = setInterval(() => {
      this.warnOfflineExpiry();
      this.persistClock();
    }, OFFLINE_EXPIRY_CHECK_INTERVAL_MS);
  }

  /**
   * Reverse air-gapped state after an online key is activated at runtime:
   * re-enable telemetry per env config, stop the offline expiry timer, and
   * restart the heartbeat/version checks.
   */
  private exitAirGappedMode(): void {
    this.stateEpoch++;
    this.airGapped = false;
    if (this.offlineExpiryTimer) {
      clearInterval(this.offlineExpiryTimer);
      this.offlineExpiryTimer = null;
    }
    this.telemetryEnabled = process.env.BETTERDB_TELEMETRY !== 'false';
    this.startHeartbeat();
    this.logger.log('Online license key active — telemetry and periodic revalidation re-enabled');
  }

  /**
   * Immediately downgrade when the active entitlement comes from an offline
   * token that has expired. Called from the read path (hasFeature & co.) so
   * expiry takes effect at once, not at the next daily timer tick.
   */
  private enforceOfflineExpiry(): void {
    if (!this.offlineClaims || this.offlineClaims.exp * 1000 > Date.now()) return;

    this.logger.error('Offline license has EXPIRED — reverting to Community tier. Download a fresh offline license from your account page.');
    this.offlineClaims = null;
    if (this.source === 'offline-token') {
      // cachedAt 0 = immediately stale: reads still see community, but the
      // next validateLicense bypasses the cache and retries online right away
      // instead of pinning a still-valid key to community for the full TTL.
      // (Air-gapped instances never reach the online path regardless.)
      this.cache = { response: this.getCommunityEntitlement('Offline license expired'), cachedAt: 0 };
      this.source = 'community';
      this.verifiedClaims = null;
    }
  }

  private warnOfflineExpiry(): void {
    this.enforceOfflineExpiry();
    if (!this.offlineClaims) return;
    const remainingMs = this.offlineClaims.exp * 1000 - Date.now();

    const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    if (remainingMs <= OFFLINE_EXPIRY_ERROR_MS) {
      this.logger.error(`Offline license expires in ${remainingDays} day(s) — download a fresh one from your account page now`);
    } else if (remainingMs <= OFFLINE_EXPIRY_WARN_MS) {
      this.logger.warn(`Offline license expires in ${remainingDays} day(s) — remember to download a fresh one from your account page`);
    }
  }

  private async validateLicenseBackground(forceOnline = false): Promise<EntitlementResponse> {
    try {
      const result = await this.validateLicense(forceOnline);
      this.isValidated = true;
      this.logger.log('License validation complete, isValidated=true');

      if (result.tier !== Tier.community) {
        this.logger.log(`License validated: upgraded to ${result.tier} tier`);
      }
      return result;
    } catch (error) {
      this.logger.warn(`License validation failed: ${(error as Error).message}, remaining in Community tier`);
      this.isValidated = true;
      this.logger.log('License validation complete (fallback), isValidated=true');
      return this.getCommunityEntitlement('Validation failed');
    }
  }

  async validateLicense(forceOnline = false): Promise<EntitlementResponse> {
    this.enforceOfflineExpiry();

    // Offline token with no license key: the token is the sole authority —
    // never phone home, and never let a keyless community check overwrite the
    // offline entitlement. Once air-gapped, this holds even after the token
    // expires (community then) — the environment can't make network calls.
    if (!this.licenseKey && (this.offlineClaims || this.airGapped)) {
      if (this.offlineClaims) {
        const response = claimsToEntitlement(this.offlineClaims);
        this.cache = { response, cachedAt: Date.now() };
        this.source = 'offline-token';
        this.verifiedClaims = this.offlineClaims;
        return response;
      }
      return this.getLicenseInfo();
    }

    // forceOnline bypasses the cache TTL (used by activateOfflineLicense) — but
    // the existing cache is left INTACT so read-path getters keep serving the
    // active tier during the network round-trip instead of falling to community.
    if (!forceOnline && this.cache && Date.now() - this.cache.cachedAt < this.cacheTtlMs) {
      this.logger.debug('Using cached entitlement');
      return this.cache.response;
    }

    const validationKey = this.licenseKey;
    const validationEpoch = this.stateEpoch;

    try {
      const response = await this.checkOnline(validationKey);

      if (this.licenseKey !== validationKey || this.stateEpoch !== validationEpoch) {
        // The key changed or a mode transition (e.g. offline activation →
        // air-gapped) happened while this check was in flight — its result
        // must not overwrite the new state, and callers should see the
        // entitlement that is actually active now, not the discarded one.
        this.logger.debug('Discarding stale entitlement response after license state change');
        return this.getLicenseInfo();
      }

      if (!response.valid) {
        // The server answered and said no — drop the persisted fallback token
        // and the stale verified claims so neither a later outage nor the
        // status endpoint can resurrect the old tier.
        this.clearPersistedToken();
        this.verifiedClaims = null;

        // Already-issued offline license tokens remain valid until exp by
        // design (independent grant) — same as on an HTTP rejection.
        const offline = this.resolveOfflineTokenFallback();
        if (offline) {
          this.cache = { response: offline, cachedAt: Date.now() };
          return offline;
        }

        this.source = 'online';
        this.cache = { response, cachedAt: Date.now() };
        this.logger.log(`Entitlement validated: ${response.tier}`);
        return response;
      }

      if (!response.token) {
        // Token-less success (legacy server, signing disabled, or a key that
        // changed epoch): drop previously persisted signed state so a later
        // outage can't resurrect another key's tier, and so /license/status
        // never mixes the fresh tier with stale claim metadata.
        this.verifiedClaims = null;
        this.clearPersistedToken();
      }

      // Online resolves to community but a valid offline token is loaded:
      // honor the offline entitlement, consistent with activateOfflineLicense
      // (an already-issued offline token is an independent grant). Without
      // this, the hourly heartbeat would silently revert a UI-activated
      // offline tier back to community.
      if (response.tier === Tier.community) {
        const offline = this.resolveOfflineTokenFallback();
        if (offline) {
          this.cache = { response: offline, cachedAt: Date.now() };
          return offline;
        }
      }

      this.cache = { response, cachedAt: Date.now() };
      this.source = 'online';
      this.logger.log(`Entitlement validated: ${response.tier}`);
      return response;
    } catch (error) {
      this.logger.error(`Entitlement validation failed: ${(error as Error).message}`);

      if (this.licenseKey !== validationKey || this.stateEpoch !== validationEpoch) {
        // Stale failure from before a state transition — leave the new state
        // (and its fallbacks) untouched.
        return this.getLicenseInfo();
      }

      // All errors here are transport/infra failures — a genuine key rejection
      // arrives as HTTP 200 valid:false and is handled on the success path.
      // Server unreachable: persisted signed entitlement → offline license
      // token → legacy stale cache (unsigned instances only) → community.
      const fallback = this.resolveSignedFallback();
      if (fallback) {
        this.cache = { response: fallback, cachedAt: Date.now() };
        return fallback;
      }

      // Legacy unsigned stale-cache grace applies ONLY to LICENSE_ALLOW_UNSIGNED
      // instances. For signed instances the token's exp is authoritative — once
      // the persisted token expires (resolveSignedFallback returns null above),
      // there is no further paid grace, so we must NOT extend a signed paid tier
      // by another maxStaleCacheMs here.
      if (
        this.allowUnsigned &&
        this.cache &&
        !this.cache.response.token &&
        this.source !== 'persisted-jwt' &&
        Date.now() - this.cache.cachedAt < this.maxStaleCacheMs
      ) {
        this.logger.warn('Using stale cache');
        return this.cache.response;
      }

      // Downgrade to community — and UPDATE the cache/source so the read-path
      // getters (hasFeature/getLicenseTier/getLicenseInfo) reflect it. Leaving
      // the old paid cache here would serve paid features indefinitely.
      const community = this.getCommunityEntitlement('Validation failed');
      this.cache = { response: community, cachedAt: Date.now() };
      this.source = 'community';
      this.verifiedClaims = null;
      return community;
    }
  }

  /**
   * Resolve a tamper-proof entitlement when the entitlement server is
   * unreachable: first the persisted signed token from the last successful
   * online check, then a configured offline license token.
   */
  private resolveSignedFallback(): EntitlementResponse | null {
    const fingerprint = this.credentialFingerprint();
    // Pure keyless instances have no credential to bind to — never honor a
    // persisted token (it could be a copied cloud/forged token). Fall through
    // to the offline-token path (which is independently bound to its own exp).
    if (!fingerprint) {
      return this.resolveOfflineTokenFallback();
    }
    try {
      const raw = readFileSync(this.licenseJwtFile, 'utf-8').trim();
      if (raw) {
        const persisted = JSON.parse(raw) as { keyFingerprint?: string; token?: string };
        if (persisted.keyFingerprint !== fingerprint) {
          // The token was earned by a different credential (key/tenant change,
          // or a copied file) — its entitlements must not apply to this one.
          this.logger.warn('Persisted entitlement token belongs to a different instance — ignoring');
        } else if (persisted.token) {
          const claims = verifyLicenseToken(persisted.token);
          this.source = 'persisted-jwt';
          this.verifiedClaims = claims;
          this.logger.warn(
            `Entitlement server unreachable — using persisted signed entitlement (${claims.tier}, valid until ${new Date(claims.exp * 1000).toISOString()})`,
          );
          return claimsToEntitlement(claims);
        }
      }
    } catch (error) {
      if (error instanceof LicenseTokenError) {
        this.logger.warn(`Persisted entitlement token rejected: ${error.message}`);
      }
      // Missing or unparseable file — fall through
    }

    return this.resolveOfflineTokenFallback();
  }

  private resolveOfflineTokenFallback(): EntitlementResponse | null {
    if (this.offlineClaims && this.offlineClaims.exp * 1000 > Date.now()) {
      this.source = 'offline-token';
      this.verifiedClaims = this.offlineClaims;
      this.logger.warn(`Falling back to offline license (${this.offlineClaims.tier})`);
      return claimsToEntitlement(this.offlineClaims);
    }
    return null;
  }

  private clearPersistedToken(): void {
    try {
      unlinkSync(this.licenseJwtFile);
      this.logger.log('Cleared persisted entitlement token');
    } catch {
      // Not present — nothing to clear
    }
  }

  private async checkOnline(licenseKeyOverride?: string | null): Promise<EntitlementResponse> {
    const isCloud = process.env.CLOUD_MODE === 'true';
    const payload: EntitlementRequest = {
      licenseKey: licenseKeyOverride ?? this.licenseKey ?? '', // Empty string for keyless instances
      instanceId: this.instanceId,
      eventType: 'license_check',
      deploymentMode: isCloud ? 'cloud' : 'self-hosted',
      stats: await this.collectStats(),
      ...(isCloud && process.env.DB_SCHEMA ? { tenantId: process.env.DB_SCHEMA } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.entitlementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Every non-2xx is a TRANSPORT/infra failure (keep the grace token) —
        // a genuinely rejected key comes back as HTTP 200 valid:false and is
        // handled on the success path. The entitlement service answers all
        // license questions with 200; a 401/403 here means the gateway
        // authorizer or proxy failed, NOT that the license is bad, so it must
        // not wipe the persisted signed-token fallback.
        throw new Error(`Entitlement server returned ${response.status}`);
      }

      const data = await response.json();

      // Verify the signed entitlement token locally so a tampered response (or
      // compromised proxy) can never grant a tier, then persist it as the
      // tamper-proof fallback for outages/restarts.
      if (data.token) {
        const claims = verifyLicenseToken(data.token); // throws → response treated as invalid
        // The online path only accepts online-mode tokens. An offline license
        // token is long-lived and floating (distributed as a downloadable
        // file); without this check a spoofed ENTITLEMENT_URL could replay one
        // as a fresh online grant and persist it to license.jwt.
        if (claims.mode !== 'online') {
          throw new LicenseTokenError('Entitlement server returned a non-online token');
        }
        // Version info is only trusted from a verified response — apply it
        // after the signature check so a spoofed/unsigned response can't plant
        // an Update-banner link.
        if (data.latestVersion) {
          this.setLatestVersion(data.latestVersion, data.releaseUrl);
        }
        // Adopt/persist the token only when this response belongs to the
        // still-active key: a key change racing an in-flight check must not
        // overwrite the fallback token (activateLicenseKey persists its own
        // token after commit; validateLicense discards the stale response).
        if ((licenseKeyOverride ?? this.licenseKey ?? '') === (this.licenseKey ?? '')) {
          this.verifiedClaims = claims;
          this.persistEntitlementToken(data.token);
        }
        // The entitlement-bearing fields (tier, features, limits, validity)
        // come from the VERIFIED claims — a forged body paired with a valid
        // token must never out-rank the signature. The raw body is trusted
        // only for display metadata (license expiry date, version info).
        return {
          ...claimsToEntitlement(claims),
          // Keep the server's explicit null (perpetual license) — only
          // substitute the token exp when the field is absent entirely.
          expiresAt:
            data.expiresAt !== undefined ? data.expiresAt : new Date(claims.exp * 1000).toISOString(),
          token: data.token,
          latestVersion: data.latestVersion,
          releaseUrl: data.releaseUrl,
        };
      }

      if (data.valid && data.tier !== Tier.community) {
        if (!this.allowUnsigned) {
          // An unsigned paid grant is indistinguishable from a spoofed
          // ENTITLEMENT_URL — refuse it. Thrown as its own error class so it
          // degrades like an outage (persisted-jwt grace intact, offline
          // token honored), NOT like a license rejection: it says nothing
          // about the license itself, only about this response.
          throw new UnsignedEntitlementError(
            `Entitlement server granted "${data.tier}" without a signed token — refusing. ` +
              'Set LICENSE_ALLOW_UNSIGNED=true only if you must talk to a legacy entitlement server.',
          );
        }
        if (!this.warnedTokenlessServer) {
          this.warnedTokenlessServer = true;
          this.logger.warn(
            'LICENSE_ALLOW_UNSIGNED=true: accepting unsigned entitlement — offline fallback will rely on the legacy unsigned cache',
          );
        }
      }

      // Version/update info for community/keyless (token-less) responses. Safe
      // even from an unverified body: releaseUrl is host+path allowlisted
      // (isTrustedReleaseUrl) and latestVersion is semver-validated.
      if (data.latestVersion) {
        this.setLatestVersion(data.latestVersion, data.releaseUrl);
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The stable identity a persisted token is bound to: the license key, or —
   * for keyless cloud tenants — the tenant schema. Returns null for a pure
   * keyless instance (no key, not cloud): such instances have no secret to
   * bind to, so they must NOT honor or persist a signed-token fallback (else a
   * cloud/forged token dropped into license.jwt would be accepted, since an
   * empty key hashes to a shared fingerprint across all keyless hosts).
   */
  private instanceCredential(): string | null {
    if (this.licenseKey) return this.licenseKey;
    if (process.env.CLOUD_MODE === 'true' && process.env.DB_SCHEMA) {
      return `cloud:${process.env.DB_SCHEMA}`;
    }
    return null;
  }

  private credentialFingerprint(): string | null {
    const cred = this.instanceCredential();
    return cred ? createHash('sha256').update(cred).digest('hex').slice(0, 16) : null;
  }

  private persistEntitlementToken(token: string): void {
    const fingerprint = this.credentialFingerprint();
    if (!fingerprint) return; // pure keyless — nothing to bind a token to
    try {
      mkdirSync(this.dataDir, { recursive: true });
      // Bound to the credential that earned it so a key/tenant change (or a
      // copied file) can't resurrect another instance's entitlements offline.
      writeFileSync(
        this.licenseJwtFile,
        JSON.stringify({ keyFingerprint: fingerprint, token }),
        { encoding: 'utf-8', mode: 0o600 },
      );
    } catch (error) {
      this.logger.warn(`Failed to persist entitlement token: ${(error as Error).message}`);
    }
  }

  private async collectStats(): Promise<Record<string, any>> {
    return {
      version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }

  private sendHeartbeat(data: Record<string, unknown> = {}): void {
    if (!this.telemetryEnabled || !this.telemetryClient) {
      return;
    }

    const licenseKey = this.getTruncatedLicenseKey();

    try {
      this.telemetryClient.capture({
        distinctId: this.instanceId,
        event: 'telemetry_ping',
        properties: {
          tier: this.getLicenseTier(),
          deploymentMode:
            process.env.CLOUD_MODE === 'true' ? 'cloud' : 'self-hosted',
          licenseKey,
          ...data,
        },
      });
    } catch {
      // Telemetry is best-effort, don't log failures
    }
  }


  /**
   * Load a previously persisted license key from disk.
   */
  private loadPersistedKey(): string | null {
    try {
      const key = readFileSync(this.licenseKeyFile, 'utf-8').trim();
      if (key) {
        this.logger.log('Loaded license key from persisted file');
        return key;
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
    return null;
  }

  /**
   * Activate a license key at runtime by validating first, then persisting only
   * after successful validation so an existing valid key is never overwritten by
   * a bad or unvalidated key.
   */
  async activateLicenseKey(key: string): Promise<EntitlementResponse> {
    let info: EntitlementResponse;
    try {
      // Validate against the candidate key without mutating shared state first.
      info = await this.checkOnline(key);
    } catch (error) {
      // A bad key returns 200 valid:false (handled below); reaching here means
      // a transport/infra failure or an unsigned-grant refusal.
      this.logger.error(`Entitlement validation failed: ${(error as Error).message}`);
      info = this.getCommunityEntitlement(
        error instanceof UnsignedEntitlementError
          ? 'Entitlement server did not return a signed token — set LICENSE_ALLOW_UNSIGNED=true for legacy servers'
          : 'Validation failed',
      );
    }

    if (!info.valid) {
      this.logger.warn(`License activation failed: ${info.error || 'unknown error'}`);
      return info;
    }

    // Commit shared state only after candidate validation succeeds.
    this.stateEpoch++;
    this.licenseKey = key;
    this.cache = { response: info, cachedAt: Date.now() };
    this.source = 'online';
    this.validationPromise = Promise.resolve(info);
    this.isValidated = true;

    // checkOnline skips token adoption for candidate keys — persist it now
    // that the key is committed. A token-less validation clears the previous
    // key's signed state instead.
    if (info.token) {
      try {
        this.verifiedClaims = verifyLicenseToken(info.token);
        this.persistEntitlementToken(info.token);
      } catch {
        // Already verified during checkOnline; failure here is unreachable
      }
    } else {
      this.verifiedClaims = null;
      this.clearPersistedToken();
    }

    if (this.airGapped) {
      this.exitAirGappedMode();
    }

    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.licenseKeyFile, key, { encoding: 'utf-8', mode: 0o600 });
      this.logger.log('License key persisted to disk');
    } catch (error) {
      this.logger.warn(`Failed to persist license key: ${(error as Error).message}`);
    }

    return info;
  }

  /**
   * Activate an offline (air-gapped) license token pasted/uploaded by the
   * user. Verified fully locally — mirrors activateLicenseKey's
   * validate-before-commit ordering.
   *
   * Returns the entitlement that is ACTIVE after the call: with no license
   * key that's the offline token's entitlement (air-gapped mode); with a key
   * configured the online entitlement stays active and the token is stored
   * as fallback only (`fallbackOnly: true`), so callers never report the
   * offline tier as activated when it isn't.
   */
  async activateOfflineLicense(
    rawToken: string,
  ): Promise<{ entitlement: EntitlementResponse; fallbackOnly: boolean }> {
    const token = rawToken.trim();

    let claims: LicenseTokenClaims;
    try {
      claims = verifyLicenseToken(token);
    } catch (error) {
      this.logger.warn(`Offline license activation failed: ${(error as Error).message}`);
      return {
        entitlement: {
          valid: false,
          tier: Tier.community,
          expiresAt: null,
          error: (error as Error).message,
        },
        fallbackOnly: false,
      };
    }

    if (claims.mode !== 'offline') {
      return {
        entitlement: {
          valid: false,
          tier: Tier.community,
          expiresAt: null,
          error: 'Not an offline license token — download the offline license from your account page',
        },
        fallbackOnly: false,
      };
    }

    // Commit the token only after verification succeeds.
    this.offlineClaims = claims;

    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.offlineLicenseFile, token, { encoding: 'utf-8', mode: 0o600 });
      this.logger.log('Offline license persisted to disk');
    } catch (error) {
      this.logger.warn(`Failed to persist offline license: ${(error as Error).message}`);
    }

    this.logger.log(
      `Offline license stored: ${claims.tier} (floating, up to ${claims.instanceLimit} instances), expires ${new Date(claims.exp * 1000).toISOString()}`,
    );

    if (!this.licenseKey) {
      // No key configured → this instance is now fully air-gapped: stop the
      // heartbeat, disable telemetry, and make the token the sole authority.
      // (enterAirGappedMode bumps the state epoch.)
      this.enterAirGappedMode();
      return { entitlement: claimsToEntitlement(claims), fallbackOnly: false };
    }

    // A key is configured: online validation keeps precedence. Decide from a
    // FRESH online result rather than a possibly-stale cache — re-validating
    // here also means we never bump the epoch to discard a concurrent in-flight
    // check that would grant a paid tier. validateLicense applies the offline
    // token iff online genuinely resolves to community (its own fallback logic).
    // forceOnline bypasses the cache TTL WITHOUT nulling the cache first, so the
    // active paid tier keeps serving read-path getters during the round-trip
    // (nulling it flashed community — and denied paid routes — for up to the
    // network timeout while this validation was in flight).
    const active = await this.validateLicense(true);
    const fallbackOnly = this.source !== 'offline-token';
    this.logger.log(
      fallbackOnly
        ? 'License key configured — offline license stored as fallback; online validation keeps precedence'
        : 'License key not granting a tier — offline license now active',
    );
    return { entitlement: active, fallbackOnly };
  }

  private getCommunityEntitlement(error?: string): EntitlementResponse {
    return {
      valid: !error,
      tier: Tier.community,
      expiresAt: null,
      error,
    };
  }

  hasFeature(feature: Feature | string): boolean {
    this.enforceOfflineExpiry();
    const entitlement = this.cache?.response || this.getCommunityEntitlement();
    // Derive features from tier using TIER_FEATURES mapping
    const tierFeatures = TIER_FEATURES[entitlement.tier];
    return tierFeatures.includes(feature as Feature);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  get isTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
  }

  getLicenseTier(): Tier {
    this.enforceOfflineExpiry();
    return this.cache?.response?.tier || Tier.community;
  }

  getLicenseInfo(): EntitlementResponse {
    this.enforceOfflineExpiry();
    return this.cache?.response || this.getCommunityEntitlement();
  }

  getLicenseSource(): LicenseSource {
    return this.source;
  }

  /**
   * True only when the offline token is the sole authority (no license key):
   * telemetry and phone-home are actually off. `source === 'offline-token'`
   * alone does NOT imply this — the token also serves as fallback while an
   * online key keeps the heartbeat running.
   */
  isAirGapped(): boolean {
    return this.airGapped;
  }

  getVerifiedClaims(): LicenseTokenClaims | null {
    return this.verifiedClaims;
  }

  getOfflineExpiresAt(): string | null {
    return this.offlineClaims ? new Date(this.offlineClaims.exp * 1000).toISOString() : null;
  }

  isClockRollbackSuspected(): boolean {
    return this.clockRollbackSuspected;
  }

  // ─────────────────────────────────────────────────────────────
  // Clock rollback detection (light — warn/flag only, never deny)
  // ─────────────────────────────────────────────────────────────

  private checkClockRollback(): void {
    try {
      const raw = readFileSync(this.clockFile, 'utf-8');
      const { lastSeenAt } = JSON.parse(raw);
      if (typeof lastSeenAt === 'number' && Date.now() < lastSeenAt - CLOCK_ROLLBACK_TOLERANCE_MS) {
        this.clockRollbackSuspected = true;
        this.logger.warn(
          `System clock appears to have moved backwards (last seen ${new Date(lastSeenAt).toISOString()}) — license expiry checks may be unreliable`,
        );
      }
    } catch {
      // No clock file yet — first boot
    }
    this.persistClock();
  }

  private persistClock(): void {
    try {
      let lastSeenAt = 0;
      try {
        lastSeenAt = JSON.parse(readFileSync(this.clockFile, 'utf-8')).lastSeenAt || 0;
      } catch {
        // First write
      }
      // Only move forward so a rolled-back clock can't erase the evidence
      if (Date.now() > lastSeenAt) {
        mkdirSync(this.dataDir, { recursive: true });
        writeFileSync(this.clockFile, JSON.stringify({ lastSeenAt: Date.now() }), {
          encoding: 'utf-8',
          mode: 0o600,
        });
      }
    } catch {
      // Best-effort
    }
  }

  getLicenseKey(): string | null {
    return this.licenseKey;
  }

  /**
   * Returns a truncated license key suffix for analytics correlation.
   * Only the last 4 characters are sent to avoid exposing the full key.
   */
  getTruncatedLicenseKey(): string | undefined {
    if (!this.licenseKey || this.licenseKey.length < 4) return undefined;
    return `...${this.licenseKey.slice(-4)}`;
  }

  async refreshLicense(): Promise<EntitlementResponse> {
    // Air-gapped: there is nothing online to refresh against — re-evaluate
    // the offline token locally instead of clearing validated state.
    if (this.airGapped) {
      this.enforceOfflineExpiry();
      const response = this.getLicenseInfo();
      this.validationPromise = Promise.resolve(response);
      return response;
    }

    // Force a fresh online check WITHOUT nulling the cache: read-path getters
    // (hasFeature/getLicenseTier) keep serving the currently-active tier during
    // the round-trip instead of flashing community for the whole request.
    // validateLicense updates the cache with the authoritative result — a real
    // downgrade (expired/revoked) still lands, just after the round-trip.
    this.validationPromise = this.validateLicenseBackground(true);
    return this.validationPromise;
  }

  /**
   * Wait for license validation to complete (with timeout).
   * Use this for routes that require paid tier access.
   * Returns cached result if already validated.
   */
  async ensureValidated(timeoutMs = 5000): Promise<EntitlementResponse> {
    this.enforceOfflineExpiry();

    // Already validated - return cached result
    if (this.isValidated && this.cache) {
      return this.cache.response;
    }

    // No validation in progress (community tier)
    if (!this.validationPromise) {
      return this.getCommunityEntitlement();
    }

    // Wait for validation with timeout
    const timeout = new Promise<EntitlementResponse>((_, reject) =>
      setTimeout(() => reject(new Error('License validation timeout')), timeoutMs),
    );

    try {
      return await Promise.race([this.validationPromise, timeout]);
    } catch (error) {
      this.logger.warn(`ensureValidated timeout, using community tier: ${(error as Error).message}`);
      return this.getCommunityEntitlement('Validation timeout');
    }
  }

  /**
   * Check if license validation has completed
   */
  isValidationComplete(): boolean {
    return this.isValidated;
  }

  // ─────────────────────────────────────────────────────────────
  // Version Check Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Store latest version from entitlement/telemetry response
   */
  private setLatestVersion(version: string, url?: string): void {
    const cleanVersion = version.startsWith('v') ? version.slice(1) : version;

    if (!validSemver(cleanVersion)) {
      this.logger.debug(`Ignoring invalid version: ${version}`);
      return;
    }

    this.latestVersion = cleanVersion;
    // Only trust a server-supplied release URL if it points at our own hosts —
    // the value rides in the (possibly unsigned) response body and is rendered
    // as a clickable "Release notes" link, so an untrusted URL is a phishing
    // vector. Otherwise derive the canonical GitHub URL.
    this.releaseUrl = this.isTrustedReleaseUrl(url)
      ? url!
      : `https://github.com/betterdb-inc/monitor/releases/tag/v${cleanVersion}`;
    this.versionCheckedAt = Date.now();

    this.logUpdateStatus();
  }

  private isTrustedReleaseUrl(url?: string): boolean {
    if (!url) return false;
    try {
      const { protocol, hostname, pathname } = new URL(url);
      if (protocol !== 'https:') return false;
      // GitHub is only trusted under our own org path — a bare github.com
      // allowlist lets a spoofed server link to any attacker repo.
      if (hostname === 'github.com') {
        return pathname.startsWith('/betterdb-inc/');
      }
      return (
        hostname === 'betterdb.com' ||
        hostname === 'www.betterdb.com' ||
        hostname.endsWith('.betterdb.com')
      );
    } catch {
      return false;
    }
  }

  /**
   * Get full version info for API endpoint
   */
  getVersionInfo(): VersionInfo {
    return {
      current: this.currentVersion,
      latest: this.latestVersion,
      updateAvailable: this.isUpdateAvailable(),
      releaseUrl: this.releaseUrl,
      checkedAt: this.versionCheckedAt,
      versionCheckIntervalMs: this.versionCheckIntervalMs,
    };
  }

  /**
   * Check if an update is available
   */
  isUpdateAvailable(): boolean {
    if (!this.latestVersion || this.currentVersion === 'unknown') {
      return false;
    }

    const currentValid = validSemver(this.currentVersion);
    const latestValid = validSemver(this.latestVersion);

    if (!currentValid || !latestValid) {
      return false;
    }

    return compare(this.latestVersion, this.currentVersion) > 0;
  }

  /**
   * Report a startup error to the entitlement server.
   * Bypasses the telemetryEnabled check — startup errors are always sent
   * because users who hit fatal errors and bail are the ones we most need
   * visibility into, and they never get a chance to opt in.
   */
  async sendStartupError(errorMessage: string, errorCategory: string): Promise<void> {
    // Air-gapped instances never phone home — not even for startup errors.
    if (this.airGapped) {
      return;
    }

    const payload = {
      licenseKey: this.licenseKey || '',
      instanceId: this.instanceId,
      eventType: 'startup_error',
      errorMessage: errorMessage.slice(0, 500),
      errorCategory,
      deploymentMode: process.env.CLOUD_MODE === 'true' ? 'cloud' as const : 'self-hosted' as const,
      version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      await fetch(this.entitlementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      // Best-effort — process is about to exit anyway
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Log update status to console
   */
  private logUpdateStatus(): void {
    if (this.isUpdateAvailable()) {
      this.logger.warn('─────────────────────────────────────────────────────');
      this.logger.warn(
        `UPDATE AVAILABLE: v${this.currentVersion} → v${this.latestVersion}`,
      );
      if (this.releaseUrl) {
        this.logger.warn(`Release notes: ${this.releaseUrl}`);
      }
      this.logger.warn('Run: docker pull betterdb/monitor:latest');
      this.logger.warn('─────────────────────────────────────────────────────');
    } else if (this.latestVersion) {
      this.logger.log(`You are running the latest version (v${this.currentVersion})`);
    }
  }
}
