/**
 * Redis/Valkey Cluster Constants
 *
 * These are architectural constants defined by the Redis/Valkey Cluster specification.
 */

/**
 * Total number of hash slots in a Redis/Valkey cluster.
 *
 * Every key in a cluster is mapped to one of these 16,384 slots using CRC16(key) mod 16384.
 * This number was chosen because:
 * - It's a power of 2 (2^14) for efficient modulo operations
 * - Small enough for compact cluster metadata (2KB bitmap)
 * - Large enough for good key distribution across nodes
 *
 * @see https://valkey.io/topics/cluster-spec/
 * @see https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
 */
export const CLUSTER_TOTAL_SLOTS = 16384;

import { SSH_NODE_FORWARD_TIMEOUT_MS } from '@betterdb/shared';

export const CLUSTER_DISCOVERY_CACHE_TTL_MS = 30000;
export const CLUSTER_CONNECTION_TIMEOUT_MS = SSH_NODE_FORWARD_TIMEOUT_MS;
export const CLUSTER_HEALTH_CHECK_INTERVAL_MS = CLUSTER_DISCOVERY_CACHE_TTL_MS;
export const CLUSTER_IDLE_TIMEOUT_MS = 60000;
export const CLUSTER_HEALTH_CHECK_TIMEOUT_MS = 2000;
