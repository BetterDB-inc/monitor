---
title: Webhooks
nav_order: 6
---

# Webhook Notifications

BetterDB can send HTTP POST requests to your endpoints when monitoring events occur. Webhooks provide real-time notifications for critical events, enabling integration with external alerting systems, incident management platforms, and custom automation workflows.

## Table of Contents

- [Quick Start](#quick-start)
- [Event Types](#event-types)
- [Payload Format](#payload-format)
- [Signature Verification](#signature-verification)
- [Retry Policy](#retry-policy)
- [Per-Webhook Configuration](#per-webhook-configuration)
- [Rate Limiting & Hysteresis](#rate-limiting--hysteresis)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Via Web UI

1. Navigate to **Settings → Webhooks** in the BetterDB Monitor interface
2. Click **Create Webhook**
3. Enter your endpoint URL (e.g., `https://api.example.com/webhooks/betterdb`)
4. Select events to subscribe to
5. (Optional) Add a secret for HMAC signature verification
6. (Optional) Configure custom headers and retry policy
7. Click **Test** to verify connectivity
8. Save the webhook

### Via API

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Alerts",
    "url": "https://api.example.com/webhooks/betterdb",
    "secret": "your-secret-key",
    "events": ["instance.down", "instance.up", "memory.critical"],
    "enabled": true
  }'
```

## Event Types

BetterDB webhooks are tiered by license level. Each tier includes events from lower tiers.

### Community Tier (Free)

All self-hosted BetterDB installations have access to these events:

| Event | Description | Trigger Condition |
|-------|-------------|-------------------|
| `instance.down` | Database unreachable | Connection/ping failure detected |
| `instance.up` | Database recovered | Connection restored after failure |
| `memory.critical` | Memory usage critical | Memory exceeds 90% of maxmemory |
| `connection.critical` | Connection limit critical | Connections exceed 90% of maxclients |
| `client.blocked` | Authentication failure | ACL log entry with reason `auth` |

### Pro Tier

Advanced monitoring events for anomaly detection and performance tracking:

| Event | Description | Trigger Condition |
|-------|-------------|-------------------|
| `slowlog.threshold` | Slow query detected | Slowlog count exceeds configured threshold |
| `replication.lag` | Replication lag detected | Replica lag exceeds acceptable threshold |
| `cluster.failover` | Cluster failover occurred | Cluster state changes or slot failures |
| `anomaly.detected` | Anomaly detected | Z-score analysis detects unusual patterns |
| `latency.spike` | Latency spike detected | Command latency spikes above baseline |
| `connection.spike` | Connection spike detected | Connection count spikes above baseline |

### Enterprise Tier

Compliance and audit events for regulated environments:

| Event | Description | Trigger Condition |
|-------|-------------|-------------------|
| `compliance.alert` | Compliance policy violation | Memory high with noeviction policy (data loss risk) |
| `audit.policy.violation` | ACL policy violation | Command/key access denied by ACL |
| `acl.violation` | ACL access violation | Runtime ACL access denied |
| `acl.modified` | ACL configuration changed | User added/removed or permissions changed |
| `config.changed` | Database configuration changed | CONFIG SET command executed |

## Payload Format

All webhooks send JSON payloads with this structure:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "event": "instance.down",
  "timestamp": 1706457600000,
  "instance": {
    "host": "valkey.example.com",
    "port": 6379
  },
  "data": {
    // Event-specific payload (see below)
  }
}
```

### HTTP Headers

BetterDB sends these headers with every webhook request:

```
Content-Type: application/json
User-Agent: BetterDB-Monitor/1.0
X-Webhook-Signature: <hmac-sha256-signature>
X-Webhook-Timestamp: <unix-timestamp-ms>
X-Webhook-Id: <webhook-id>
X-Webhook-Delivery-Id: <delivery-id>
X-Webhook-Event: <event-type>
```

### Event-Specific Payloads

#### instance.down / instance.up

```json
{
  "message": "Database instance unreachable: Connection refused",
  "reason": "Connection refused",
  "detectedAt": "2024-01-28T12:00:00.000Z"
}
```

#### memory.critical

```json
{
  "metric": "memory_used_percent",
  "value": 92.5,
  "threshold": 90,
  "maxmemory": 1073741824,
  "usedMemory": 993001472,
  "message": "Memory usage critical: 92.5% (threshold: 90%)"
}
```

#### connection.critical

```json
{
  "metric": "connected_clients_percent",
  "value": 95.2,
  "threshold": 90,
  "maxClients": 10000,
  "connectedClients": 9520,
  "message": "Connection usage critical: 95.2% (threshold: 90%)"
}
```

#### client.blocked

```json
{
  "reason": "auth",
  "username": "app_user",
  "clientInfo": "192.168.1.100:54321",
  "count": 5,
  "timestamp": 1706457600,
  "message": "Client blocked: authentication failure by app_user@192.168.1.100:54321 (count: 5)"
}
```

#### slowlog.threshold (Pro)

```json
{
  "slowlogCount": 150,
  "threshold": 100,
  "message": "Slowlog count (150) exceeds threshold (100)",
  "timestamp": 1706457600000
}
```

#### replication.lag (Pro)

```json
{
  "lagSeconds": 45,
  "threshold": 30,
  "masterLinkStatus": "up",
  "message": "Replication lag (45s) exceeds threshold (30s)",
  "timestamp": 1706457600000
}
```

#### cluster.failover (Pro)

```json
{
  "clusterState": "fail",
  "previousState": "ok",
  "slotsAssigned": 16384,
  "slotsFailed": 128,
  "knownNodes": 6,
  "message": "Cluster state changed from ok to fail",
  "timestamp": 1706457600000
}
```

#### anomaly.detected (Pro)

```json
{
  "anomalyId": "anom-550e8400-e29b-41d4-a716-446655440000",
  "metricType": "ops_per_sec",
  "anomalyType": "spike",
  "severity": "warning",
  "value": 50000,
  "baseline": 10000,
  "stdDev": 5000,
  "zScore": 4.2,
  "threshold": 3.0,
  "message": "Unusual spike in ops_per_sec: 50000 (baseline: 10000, z-score: 4.2)",
  "timestamp": 1706457600000
}
```

#### compliance.alert (Enterprise)

```json
{
  "complianceType": "data_retention",
  "severity": "high",
  "memoryUsedPercent": 92.5,
  "maxmemoryPolicy": "noeviction",
  "message": "Compliance alert: Memory at 92.5% with noeviction policy - data loss risk",
  "timestamp": 1706457600000
}
```

#### audit.policy.violation (Enterprise)

```json
{
  "username": "readonly_user",
  "clientInfo": "10.0.1.50:43210",
  "violationType": "command",
  "violatedCommand": "SET",
  "count": 3,
  "message": "ACL command violation by readonly_user@10.0.1.50:43210 (count: 3)",
  "timestamp": 1706457600000
}
```

#### acl.violation (Enterprise)

```json
{
  "username": "app_user",
  "command": "FLUSHALL",
  "reason": "command",
  "message": "ACL access denied: app_user attempted FLUSHALL",
  "timestamp": 1706457600000
}
```

#### acl.modified (Enterprise)

```json
{
  "modifiedBy": "admin",
  "changeType": "user_added",
  "affectedUser": "new_user",
  "message": "ACL configuration changed: user_added (user: new_user)",
  "timestamp": 1706457600000
}
```

#### config.changed (Enterprise)

```json
{
  "configKey": "maxmemory-policy",
  "oldValue": "noeviction",
  "newValue": "allkeys-lru",
  "modifiedBy": "admin",
  "message": "Configuration changed: maxmemory-policy = allkeys-lru (was: noeviction)",
  "timestamp": 1706457600000
}
```

## Signature Verification

If you configure a webhook secret, BetterDB signs each request using HMAC-SHA256. This allows you to verify that requests are genuinely from your BetterDB instance.

### Signature Algorithm

```
signature = HMAC-SHA256(secret, timestamp + "." + payload)
```

The signature is sent in the `X-Webhook-Signature` header and the timestamp in `X-Webhook-Timestamp`.

### Verification (Node.js)

```javascript
const crypto = require('crypto');

function verifyWebhook(req) {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const payload = JSON.stringify(req.body);
  const secret = process.env.WEBHOOK_SECRET;

  // Construct signed payload
  const signedPayload = `${timestamp}.${payload}`;

  // Calculate expected signature
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Timing-safe comparison
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSig)
  );
}

// Express.js example
app.post('/webhooks/betterdb', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body);
  console.log('Received event:', event.event);

  // Process webhook...

  res.status(200).send('OK');
});
```

### Verification (Python)

```python
import hmac
import hashlib
from flask import Flask, request, abort

app = Flask(__name__)
WEBHOOK_SECRET = 'your-secret-key'

def verify_webhook(request):
    signature = request.headers.get('X-Webhook-Signature')
    timestamp = request.headers.get('X-Webhook-Timestamp')
    payload = request.get_data(as_text=True)

    # Construct signed payload
    signed_payload = f"{timestamp}.{payload}"

    # Calculate expected signature
    expected = hmac.new(
        WEBHOOK_SECRET.encode(),
        signed_payload.encode(),
        hashlib.sha256
    ).hexdigest()

    # Timing-safe comparison
    return hmac.compare_digest(signature, expected)

@app.route('/webhooks/betterdb', methods=['POST'])
def handle_webhook():
    if not verify_webhook(request):
        abort(401, 'Invalid signature')

    event = request.get_json()
    print(f"Received event: {event['event']}")

    # Process webhook...

    return 'OK', 200
```

### Verification (Go)

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "crypto/subtle"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
)

const webhookSecret = "your-secret-key"

func verifyWebhook(r *http.Request, body []byte) bool {
    signature := r.Header.Get("X-Webhook-Signature")
    timestamp := r.Header.Get("X-Webhook-Timestamp")

    // Construct signed payload
    signedPayload := timestamp + "." + string(body)

    // Calculate expected signature
    h := hmac.New(sha256.New, []byte(webhookSecret))
    h.Write([]byte(signedPayload))
    expected := hex.EncodeToString(h.Sum(nil))

    // Timing-safe comparison
    return subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) == 1
}

func handleWebhook(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)

    if !verifyWebhook(r, body) {
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }

    fmt.Println("Webhook verified!")
    w.WriteHeader(http.StatusOK)
}
```

### Replay Attack Prevention

The timestamp in `X-Webhook-Timestamp` should be validated to prevent replay attacks. Reject requests with timestamps older than 5 minutes:

```javascript
function isRecentTimestamp(timestamp) {
  const now = Date.now();
  const age = now - parseInt(timestamp);
  return age < 5 * 60 * 1000; // 5 minutes
}
```

## Retry Policy

Failed webhook deliveries are automatically retried with exponential backoff. This ensures transient network issues don't cause missed notifications.

### Default Retry Behavior

| Attempt | Delay | Total Elapsed |
|---------|-------|---------------|
| 1 | Immediate | 0s |
| 2 | 1 second | 1s |
| 3 | 2 seconds | 3s |
| 4 | 4 seconds | 7s |

**Default Configuration:**
- **Max retries:** 3
- **Initial delay:** 1000ms
- **Backoff multiplier:** 2x
- **Max delay:** 60000ms (1 minute)

### Custom Retry Policy

You can configure custom retry policies per webhook:

```json
{
  "name": "Critical Alerts",
  "url": "https://api.example.com/webhooks/critical",
  "events": ["instance.down"],
  "retryPolicy": {
    "maxRetries": 5,
    "initialDelayMs": 2000,
    "backoffMultiplier": 2,
    "maxDelayMs": 300000
  }
}
```

### Dead Letter Queue

After all retries are exhausted, the delivery moves to **dead letter** status. Dead letter deliveries can be:

- Viewed in the webhook delivery history (UI or API)
- Manually retried via the UI or API
- Used for alerting on persistent failures

```bash
# View webhook deliveries (including dead letters)
curl http://localhost:3001/api/webhooks/{id}/deliveries

# Manually retry a dead letter delivery
curl -X POST http://localhost:3001/api/webhooks/deliveries/{deliveryId}/retry
```

### Success Criteria

A webhook delivery is considered successful when:
- HTTP response status is 2xx (200-299)
- Response received within timeout (default: 30 seconds)

Any other response (4xx, 5xx, timeout, network error) triggers a retry.

## Per-Webhook Configuration

Each webhook can be individually configured with custom delivery settings, alert behavior, and thresholds. This enables different notification channels to have different sensitivity levels.

### Delivery Configuration

Control how webhook requests are sent:

```json
{
  "name": "Slow Endpoint",
  "url": "https://slow-api.example.com/webhook",
  "events": ["instance.down"],
  "deliveryConfig": {
    "timeoutMs": 60000,
    "maxResponseBodyBytes": 50000
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutMs` | integer | 30000 | Request timeout in milliseconds (1000-120000) |
| `maxResponseBodyBytes` | integer | 10000 | Max response body to store (1000-100000) |

### Alert Configuration

Control hysteresis behavior for threshold-based alerts:

```json
{
  "name": "Sensitive Alerts",
  "url": "https://api.example.com/webhook",
  "events": ["memory.critical"],
  "alertConfig": {
    "hysteresisFactor": 0.95
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hysteresisFactor` | number | 0.9 | Recovery threshold = trigger x factor (0.5-0.99) |

**How hysteresis works:**
- Alert fires when metric crosses threshold
- Alert clears when metric drops below `threshold x hysteresisFactor`
- Example: 90% threshold with 0.9 factor -> clears at 81%
- Lower factor = wider buffer = fewer false re-triggers

### Custom Thresholds

Override default alert thresholds per webhook. This enables different notification channels for different severity levels:

```json
{
  "name": "Early Warning - Slack",
  "url": "https://hooks.slack.com/services/...",
  "events": ["memory.critical", "connection.critical"],
  "thresholds": {
    "memoryCriticalPercent": 75,
    "connectionCriticalPercent": 70
  }
}
```

```json
{
  "name": "Critical - PagerDuty",
  "url": "https://events.pagerduty.com/...",
  "events": ["memory.critical", "connection.critical"],
  "thresholds": {
    "memoryCriticalPercent": 95,
    "connectionCriticalPercent": 95
  }
}
```

| Field | Type | Default | Applies To |
|-------|------|---------|------------|
| `memoryCriticalPercent` | integer | 90 | `memory.critical` |
| `connectionCriticalPercent` | integer | 90 | `connection.critical` |
| `complianceMemoryPercent` | integer | 80 | `compliance.alert` |
| `slowlogCount` | integer | 100 | `slowlog.threshold` |
| `replicationLagSeconds` | integer | 10 | `replication.lag` |
| `latencySpikeMs` | integer | 0 (auto) | `latency.spike` |
| `connectionSpikeCount` | integer | 0 (auto) | `connection.spike` |

**Notes:**
- Thresholds only apply to events the webhook subscribes to
- Value of `0` for spike thresholds means "use automatic baseline detection"
- Each webhook tracks alert state independently (one webhook recovering doesn't affect others)

### Full Configuration Example

```json
{
  "name": "Production Critical Alerts",
  "url": "https://api.pagerduty.com/webhooks",
  "secret": "whsec_abc123",
  "enabled": true,
  "events": ["instance.down", "instance.up", "memory.critical", "connection.critical"],
  "headers": {
    "X-Routing-Key": "prod-database-alerts"
  },
  "retryPolicy": {
    "maxRetries": 5,
    "initialDelayMs": 2000,
    "backoffMultiplier": 2,
    "maxDelayMs": 300000
  },
  "deliveryConfig": {
    "timeoutMs": 10000,
    "maxResponseBodyBytes": 5000
  },
  "alertConfig": {
    "hysteresisFactor": 0.85
  },
  "thresholds": {
    "memoryCriticalPercent": 95,
    "connectionCriticalPercent": 90
  }
}
```

## Rate Limiting & Hysteresis

To prevent alert fatigue from metrics oscillating around thresholds, BetterDB implements **hysteresis**:

### How Hysteresis Works

- Alert **fires** when metric exceeds threshold
- Alert **clears** only when metric drops below 90% of threshold
- This creates a 10% "buffer zone" to prevent rapid on/off alerts

**Example:** Memory alert at 90% threshold
- Alert fires when memory reaches **90%**
- Alert clears when memory drops below **81%** (90% × 0.9)
- If memory oscillates between 89% and 91%, alert fires once and stays active

### Alert State Tracking

BetterDB maintains alert state in memory using an LRU cache:
- **Max alerts:** 1000 (sufficient for 100 instances × 10 metrics)
- **TTL:** 24 hours (prevents indefinite growth)
- **Eviction:** Oldest alerts evicted if limit exceeded

### Threshold-Based Events

The following events use configurable thresholds with hysteresis:

| Event | Default Threshold | Config Key |
|-------|-------------------|------------|
| `memory.critical` | 90% | `memoryCriticalPercent` |
| `connection.critical` | 90% | `connectionCriticalPercent` |
| `slowlog.threshold` (Pro) | 100 entries | `slowlogCount` |
| `replication.lag` (Pro) | 10 seconds | `replicationLagSeconds` |
| `latency.spike` (Pro) | 0 (auto) | `latencySpikeMs` |
| `connection.spike` (Pro) | 0 (auto) | `connectionSpikeCount` |
| `compliance.alert` (Enterprise) | 80% | `complianceMemoryPercent` |

See [Custom Thresholds](#custom-thresholds) for per-webhook configuration.

### Non-Threshold Events

These events fire immediately without hysteresis:

- `instance.down` / `instance.up` (state change events)
- `client.blocked` (each occurrence)
- `anomaly.detected` (each detection)
- `acl.violation` (each violation)
- `audit.policy.violation` (each violation)
- `acl.modified` (each change)
- `config.changed` (each change)

## API Reference

### List Webhooks

```bash
GET /api/webhooks
```

Returns all webhooks for the current instance with secrets redacted.

**Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Production Alerts",
    "url": "https://api.example.com/webhooks",
    "secret": "whsec_abc1***",
    "enabled": true,
    "events": ["instance.down", "instance.up"],
    "headers": {},
    "retryPolicy": {
      "maxRetries": 3,
      "backoffMultiplier": 2,
      "initialDelayMs": 1000,
      "maxDelayMs": 60000
    },
    "createdAt": 1706457600000,
    "updatedAt": 1706457600000
  }
]
```

### Create Webhook

```bash
POST /api/webhooks
Content-Type: application/json

{
  "name": "Production Alerts",
  "url": "https://api.example.com/webhooks/betterdb",
  "secret": "your-secret-key",
  "events": ["instance.down", "instance.up", "memory.critical"],
  "enabled": true,
  "headers": {
    "X-Custom-Header": "value"
  },
  "retryPolicy": {
    "maxRetries": 5,
    "initialDelayMs": 2000,
    "backoffMultiplier": 2,
    "maxDelayMs": 300000
  }
}
```

**Response:** `201 Created` with webhook object (secret redacted)

**Validation:**
- URL must be valid HTTPS (HTTP allowed in development)
- Events must be valid webhook event types
- Events must match your license tier (403 if attempting to subscribe to locked events)
- Custom headers cannot include restricted headers (Host, Content-Length, etc.)

### Update Webhook

```bash
PUT /api/webhooks/{id}
Content-Type: application/json

{
  "name": "Updated Name",
  "enabled": false,
  "events": ["instance.down"]
}
```

**Response:** `200 OK` with updated webhook object

### Delete Webhook

```bash
DELETE /api/webhooks/{id}
```

**Response:** `204 No Content`

**Note:** Deleting a webhook also deletes all associated delivery history.

### Test Webhook

```bash
POST /api/webhooks/{id}/test
```

Sends a test payload to verify connectivity. Uses the first subscribed event type or `instance.down` as fallback.

**Response:**
```json
{
  "success": true,
  "statusCode": 200,
  "responseBody": "OK",
  "durationMs": 145
}
```

### Get Webhook Deliveries

```bash
GET /api/webhooks/{id}/deliveries?limit=50&offset=0
```

**Response:**
```json
[
  {
    "id": "del-550e8400-e29b-41d4-a716-446655440000",
    "webhookId": "550e8400-e29b-41d4-a716-446655440000",
    "eventType": "instance.down",
    "status": "success",
    "statusCode": 200,
    "responseBody": "OK",
    "attempts": 1,
    "durationMs": 145,
    "createdAt": 1706457600000,
    "completedAt": 1706457600145
  }
]
```

**Delivery Status Values:**
- `pending` - Queued for delivery
- `success` - Delivered successfully (2xx response)
- `retrying` - Failed, will retry
- `dead_letter` - All retries exhausted
- `failed` - Permanent failure (not retryable)

### Retry Failed Delivery

```bash
POST /api/webhooks/deliveries/{deliveryId}/retry
```

Manually retry a failed or dead letter delivery.

**Response:** `202 Accepted` with message "Retry queued"

### Get Allowed Events

```bash
GET /api/webhooks/allowed-events
```

Returns webhook events allowed for your current license tier.

**Response:**
```json
{
  "tier": "pro",
  "allowedEvents": [
    "instance.down",
    "instance.up",
    "memory.critical",
    "connection.critical",
    "client.blocked",
    "slowlog.threshold",
    "replication.lag",
    "cluster.failover",
    "anomaly.detected",
    "latency.spike",
    "connection.spike"
  ],
  "lockedEvents": [
    "compliance.alert",
    "audit.policy.violation",
    "acl.violation",
    "acl.modified",
    "config.changed"
  ]
}
```

### Get Retry Queue Stats

```bash
GET /api/webhooks/stats/retry-queue
```

**Response:**
```json
{
  "pendingRetries": 5,
  "nextRetryTime": 1706457665000
}
```

## Troubleshooting

### Webhook Not Firing

**Check webhook configuration:**

1. Verify webhook is **enabled** (`enabled: true`)
2. Confirm you're subscribed to the event type
3. Check your license tier includes the event:
   ```bash
   curl http://localhost:3001/api/webhooks/allowed-events
   ```
4. Review delivery history for errors:
   ```bash
   curl http://localhost:3001/api/webhooks/{id}/deliveries
   ```

**Check event is being triggered:**

- For `memory.critical`, verify memory is actually exceeding 90%
- For `anomaly.detected`, ensure anomaly detection is enabled (Pro tier required)
- For threshold events, remember hysteresis: alert fires once and won't re-fire until recovery

**Verify endpoint reachability:**

```bash
# Test webhook connectivity
curl -X POST http://localhost:3001/api/webhooks/{id}/test
```

### Signature Verification Failing

**Common issues:**

1. **Using parsed JSON instead of raw body**
   - Solution: Use raw body string for signature verification
   - Express.js: `express.raw({ type: 'application/json' })`
   - Flask: `request.get_data(as_text=True)`

2. **Timestamp not included in signed payload**
   - Correct format: `timestamp + "." + payload`
   - Example: `1706457600000.{"event":"instance.down",...}`

3. **Secret mismatch**
   - Verify secret matches exactly (no trailing whitespace)
   - Check secret wasn't redacted when retrieving webhook details

4. **Character encoding issues**
   - Ensure UTF-8 encoding for all strings
   - Use `Buffer.from(str, 'utf8')` in Node.js

**Debug signature generation:**

```javascript
console.log('Timestamp:', req.headers['x-webhook-timestamp']);
console.log('Payload:', req.body.toString());
console.log('Signed payload:', `${timestamp}.${payload}`);
console.log('Expected signature:', expectedSig);
console.log('Received signature:', signature);
```

### Too Many Alerts

**Threshold oscillation:**

- Hysteresis prevents rapid on/off, but sustained oscillation will still alert
- Solution: Adjust thresholds to appropriate levels for your workload
- For advanced alerting logic, consider using Prometheus + Alertmanager

**Alert not clearing:**

- Alerts use 10% hysteresis - metric must drop significantly below threshold
- Example: 90% memory alert clears at 81%, not 89%
- Check if metric is genuinely recovering

**Multiple webhook subscriptions:**

- If multiple webhooks subscribe to the same event, all will fire
- Review webhook configuration to avoid duplicates

### High Delivery Latency

**Network issues:**

- Check network connectivity between BetterDB and your endpoint
- Consider using a webhook relay service for reliability
- Verify your endpoint responds quickly (< 5 seconds recommended)

**Timeout configuration:**

- Default timeout: 30 seconds
- Long-running endpoints may need optimization
- Consider async processing: return 200 immediately, process in background

**Retry backlog:**

- Check retry queue stats: `GET /api/webhooks/stats/retry-queue`
- High pending retries indicate delivery issues
- Review dead letter queue for patterns

### SSRF Security Error

BetterDB blocks private IP addresses to prevent SSRF attacks:

**Blocked in production:**
- `localhost`, `127.0.0.1`, `0.0.0.0`
- Private IP ranges: `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`
- Link-local: `169.254.x.x`
- IPv6 private ranges

**Allowed in development:**
- `localhost` and `127.x.x.x` are allowed when `NODE_ENV !== 'production'`

**Solution:**
- Use public endpoints or reverse proxy
- For testing, set `NODE_ENV=development`

### Delivery History Missing

**Memory storage:**
- `STORAGE_TYPE=memory` loses delivery history on restart
- Consider PostgreSQL for persistent storage

**Retention limits:**
- Memory adapter keeps last 1000 deliveries per webhook
- PostgreSQL has no artificial limits

**Pruning:**
- Old deliveries can be manually pruned via API
- Configure retention policies as needed

## Integration Examples

### Slack

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Slack Notifications",
    "url": "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK",
    "events": ["instance.down", "memory.critical"],
    "enabled": true
  }'
```

Your endpoint should transform BetterDB payloads to Slack's format.

### PagerDuty

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PagerDuty Incidents",
    "url": "https://events.pagerduty.com/v2/enqueue",
    "headers": {
      "Authorization": "Token token=YOUR_INTEGRATION_KEY"
    },
    "events": ["instance.down", "cluster.failover"],
    "enabled": true
  }'
```

### Discord

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Discord Alerts",
    "url": "https://discord.com/api/webhooks/YOUR/DISCORD/WEBHOOK",
    "events": ["instance.down", "instance.up"],
    "enabled": true
  }'
```

### Microsoft Teams

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Teams Notifications",
    "url": "https://outlook.office.com/webhook/YOUR/TEAMS/WEBHOOK",
    "events": ["memory.critical", "connection.critical"],
    "enabled": true
  }'
```

### Custom HTTP Endpoint

```javascript
const express = require('express');
const app = express();

app.post('/webhooks/betterdb', express.json(), (req, res) => {
  const { event, timestamp, instance, data } = req.body;

  console.log(`[${new Date(timestamp).toISOString()}] ${event} on ${instance.host}:${instance.port}`);

  // Custom logic based on event type
  switch (event) {
    case 'instance.down':
      // Send SMS alert
      // Create incident ticket
      break;
    case 'memory.critical':
      // Scale up resources
      // Send email to ops team
      break;
    case 'anomaly.detected':
      // Log to anomaly dashboard
      // Trigger auto-remediation
      break;
  }

  res.status(200).send('OK');
});

app.listen(8080);
```

## Best Practices

### Security

1. **Always use secrets** for production webhooks
2. **Validate signatures** on your endpoint
3. **Check timestamps** to prevent replay attacks
4. **Use HTTPS** for webhook URLs (required in production)
5. **Rotate secrets** periodically

### Reliability

1. **Return 200 quickly** - don't block webhook handler
2. **Process async** - queue work for background processing
3. **Implement retries** on your endpoint for transient failures
4. **Monitor delivery history** for patterns
5. **Set up dead letter alerts** for persistent failures

### Performance

1. **Keep response times < 5 seconds** to avoid timeouts
2. **Use connection pooling** for database operations
3. **Limit payload processing** - only extract needed fields
4. **Cache frequently accessed data** to reduce latency
5. **Consider webhook relay** services for high-volume workloads

### Operational

1. **Test webhooks** before enabling in production
2. **Monitor delivery success rate** via API
3. **Set appropriate retry policies** for your SLA
4. **Document your event handling** logic
5. **Use multiple webhooks** for different alert severities

## Further Reading

- [Configuration Reference](configuration.md) - Webhook-related environment variables
- [Anomaly Detection](anomaly-detection.md) - Understanding anomaly events
- [Prometheus Metrics](prometheus-metrics.md) - Metrics exposed by BetterDB
- [API Documentation](http://localhost:3001/api) - Complete OpenAPI/Swagger docs
