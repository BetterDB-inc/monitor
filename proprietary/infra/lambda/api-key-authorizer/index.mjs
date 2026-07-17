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

    if (!cachedKey || Date.now() - lastAttempt > CACHE_TTL_MS) {
        try {
            await fetchKey();
        } catch (err) {
            // A transient SSM error must not take down the whole gateway when
            // we already hold a valid key — keep serving the last-known-good
            // value; the next attempt is a full TTL away (lastAttempt advanced
            // in fetchKey). Fail closed only on cold start, when there is no
            // cached key to fall back on.
            if (!cachedKey) {
                throw err;
            }
            console.error("SSM refresh failed; serving cached key", err);
        }
    }

    return { isAuthorized: apiKey === cachedKey };
};