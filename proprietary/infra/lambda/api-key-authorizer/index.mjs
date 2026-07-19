import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient();
let cachedKey;
// When the last refresh was ATTEMPTED (success OR failure), so a transient SSM
// outage doesn't turn into a per-request retry storm — see fetchKey().
let lastAttempt = 0;

// TTL-based cache: every warm container re-reads the key from SSM at most once
// per TTL, regardless of whether requests match. This is what makes a rotation
// actually REVOKE the old key — a mismatch-only refetch would keep a container
// pinned on a leaked K_old forever (self-matching requests never trigger a
// re-read). It also bounds SSM traffic to ~1 call per TTL per container, so a
// flood of bad keys can't amplify GetParameter calls. Rotation propagates
// within TTL (plus the gateway's authorizer_result_ttl for cached verdicts).
const CACHE_TTL_MS = 60_000;

async function fetchKey() {
    // Advance the attempt clock UP FRONT so a failed fetch still counts —
    // otherwise the clock would never move during an SSM outage and every
    // request would re-hit SSM. This bounds refreshes to ~1 per TTL even when
    // SSM is failing; cachedKey is only replaced on success.
    lastAttempt = Date.now();
    const res = await ssm.send(
        new GetParameterCommand({
            Name: process.env.SSM_PARAM_NAME,
            WithDecryption: true,
        })
    );
    cachedKey = res.Parameter.Value;
    return cachedKey;
}

export const handler = async (event) => {
    const apiKey = event.headers?.["x-api-key"];

    if (!apiKey) {
        return { isAuthorized: false };
    }

    // Gate EVERY fetch on the TTL — including the cold-start fetch (lastAttempt
    // starts at 0, so the first request always fetches). A prior `!cachedKey ||`
    // clause meant a cold start with SSM unreachable re-hit GetParameter on every
    // single request (cachedKey never populates), storming SSM exactly when it is
    // already unhealthy. Bounding cold-start attempts to ~1 per TTL is the whole
    // point of tracking lastAttempt.
    if (Date.now() - lastAttempt > CACHE_TTL_MS) {
        try {
            await fetchKey();
        } catch (err) {
            // Transient SSM error: keep serving the last-known-good key if we
            // hold one; the next attempt is a full TTL away (lastAttempt advanced
            // in fetchKey). If we have no cached key (cold start), fall through to
            // the deny below rather than re-throwing every request.
            console.error("SSM refresh failed", err);
        }
    }

    if (!cachedKey) {
        // No key available (cold start with SSM unreachable). Fail CLOSED —
        // denying is safe and cheap, and it does not storm SSM: the next fetch
        // is a TTL away regardless of request volume.
        return { isAuthorized: false };
    }

    return { isAuthorized: apiKey === cachedKey };
};