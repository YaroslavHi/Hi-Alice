# A7 — Observability

## Three Pillars

| Pillar | Implementation |
|--------|---------------|
| Structured JSON logs | pino (Fastify native) |
| Metrics | Prometheus text format at `GET /metrics` |
| Correlation | `X-Request-Id` propagated from Yandex through all log lines |

---

## Structured Logs

All logs are JSON in production. Example:

```json
{
  "level": 30,
  "time":  1745229841023,
  "reqId": "yandex-uuid-abc-123",
  "req":   { "method": "POST", "url": "/v1.0/user/devices/action", "remoteAddress": "213.180.204.3" },
  "msg":   "Token validated",
  "linkId":    "link-uuid-001",
  "hiHouseId": "sb-00A3F2"
}
```

### PII / Secrets Redaction

These fields are automatically replaced with `[REDACTED]` in all log lines:

```
req.headers.authorization
req.headers.cookie
body.client_secret
body.code
body.refresh_token
body.access_token
body.access_token_encrypted
body.refresh_token_encrypted
```

**Tokens never appear in logs.** Only non-sensitive derived identifiers (link UUID, house ID) are logged.

### Key Log Events

| Event | Level | Message |
|-------|-------|---------|
| Token valid | DEBUG | `Token validated` + `linkId`, `hiHouseId` |
| Token invalid | WARN  | `Bearer token invalid or expired` |
| Token issued | INFO  | `Token pair issued` |
| Account unlinked | INFO | `Account unlinked` |
| P4 offline | WARN  | `P4 offline during discovery — returning empty device list` |
| P4 relay timeout | ERROR | `P4 relay timeout during discovery` |
| Action confirmed | DEBUG | `Action confirmed by P4` |
| Notification enqueued | DEBUG | `State notification enqueued` |
| Notification deduped | DEBUG | `State notification deduplicated` |
| Yandex callback delivered | DEBUG | `Yandex callback delivered` |
| Yandex callback failed | ERROR | `Yandex callback failed after all retries` |

---

## Metrics (GET /metrics)

Prometheus text format, available at `GET /metrics`.
Protect this endpoint at network/Nginx level — not intended for Yandex.

### Counters

```
alice_http_requests_total{method,route,status}    — all HTTP requests
alice_token_validations_total{result}             — valid / invalid / missing
alice_p4_relay_calls_total{endpoint,status}       — ok / timeout / offline / error
alice_notifications_enqueued_total{kind}          — state / discovery
alice_notifications_delivered_total{kind,result}  — ok / failed
alice_oauth_events_total{event}                   — token_issued / token_refreshed / unlinked
```

### Histograms

```
alice_http_duration_ms{route}   — request duration (buckets: 5,10,25,50,100,250,500,1000,2500,5000,10000ms)
```

### Example output

```
# HELP alice_http_requests_total Total HTTP requests
# TYPE alice_http_requests_total counter
alice_http_requests_total{method="POST",route="/v1.0/user/devices/action",status="200"} 42
alice_http_requests_total{method="GET",route="/v1.0/user/devices",status="200"} 18
alice_http_requests_total{method="GET",route="/v1.0/user/devices",status="401"} 2
# TYPE alice_http_duration_ms histogram
alice_http_duration_ms_bucket{route="/v1.0/user/devices/action",le="250"} 35
alice_http_duration_ms_bucket{route="/v1.0/user/devices/action",le="500"} 41
alice_http_duration_ms_sum{route="/v1.0/user/devices/action"} 8234
alice_http_duration_ms_count{route="/v1.0/user/devices/action"} 42
```

---

## Correlation Chain (X-Request-Id)

Yandex sends `X-Request-Id` on every webhook request. We:

1. Extract it in the `request-id` plugin (or generate a UUID if absent)
2. Attach to `request.requestId`
3. Echo in response header `X-Request-Id`
4. Include in every response body as `request_id`
5. Include in every log line via `genReqId` → pino automatically adds it as `reqId`
6. Pass to P4 relay and audit log

This makes it possible to trace a single Yandex request across all system components.

### Alerting Recommendations

| Metric | Alert condition |
|--------|----------------|
| `alice_http_requests_total{status="401"}` | Rate > 10/min |
| `alice_p4_relay_calls_total{status="timeout"}` | > 5% of relay calls |
| `alice_notifications_delivered_total{result="failed"}` | > 0 in 5 min window |
| `alice_http_duration_ms_bucket{le="500"}` action route | < 95% of requests within 500ms |
