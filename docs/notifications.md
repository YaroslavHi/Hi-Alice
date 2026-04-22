# A5 — Notifications

## Critical Rule

Only **owner-confirmed** events trigger notifications. P4 publishes state only after hardware execution is confirmed via STM32 SQI.

## Endpoints (Yandex outbound)

| Yandex endpoint | Trigger |
|----------------|---------|
| `POST /api/v1/skills/{id}/callback/state` | Device state changed |
| `POST /api/v1/skills/{id}/callback/discovery` | Device list changed |

## Internal Webhook Endpoints (P4 Relay → alice-adapter)

| Path | Trigger |
|------|---------|
| `POST /internal/p4/state-change` | P4 device state update |
| `POST /internal/p4/discovery-change` | P4 device inventory changed |

## Queue Design

```
P4 Relay               alice-adapter                  Redis
    │                       │                            │
    │─ POST /internal/p4/   │                            │
    │  state-change         │                            │
    │                       │─ dedup check ─────────────▶│
    │                       │  SET NX alice:notif:dedup: │
    │                       │  {type}:{user}:{device}    │
    │                       │                            │
    │                       │  new? LPUSH queue ────────▶│
    │                       │  dup? skip                 │
    │                       │                            │
    202                     │                            │
                            │                            │
                Worker (background loop)                │
                            │◀── BRPOP queue ───────────│
                            │    (blocks 5s timeout)     │
                            │                            │
                            │── call Yandex API          │
                            │   (retry ×3)               │
```

### Queue Key

```
alice:notif:queue  (Redis LIST, LPUSH produce, BRPOP consume)
```

### Dedup Key Pattern

```
alice:notif:dedup:state:{yandex_user_id}:{logical_device_id}  TTL=30s
alice:notif:dedup:discovery:{yandex_user_id}                  TTL=30s
```

A SET NX (set if not exists) atomically prevents duplicate enqueue within the TTL window.

## Retry Policy

```
Attempt 1: immediate
Attempt 2: +1 000ms
Attempt 3: +2 000ms
429 response: honour Retry-After header
4xx (client error): abort immediately — misconfiguration, not transient
Exhausted: log ERROR, drop (Yandex reconciles on next discovery)
```

## State Notification Payload

```json
{
  "ts": 1745229841,
  "payload": {
    "user_id": "yandex-uid-123",
    "devices": [{
      "id": "hi:sb-00A3F2:relay-42",
      "capabilities": [
        { "type": "devices.capabilities.on_off",
          "state": { "instance": "on", "value": true },
          "last_updated": 1745229841 }
      ],
      "properties": []
    }]
  }
}
```

## Discovery Notification Payload

```json
{
  "ts": 1745229841,
  "payload": { "user_id": "yandex-uid-123" }
}
```

Yandex re-issues `GET /v1.0/user/devices` after receiving discovery notification.

## Private Skill Limitation

Yandex callback API (`dialogs.yandex.net/api/v1/skills/{id}/callback/*`) requires the skill to be published or in testing mode. During development, callbacks may be rejected with 403 — this is expected. The queue and retry logic remains active; delivery resumes when the skill is approved.

Required env vars: `YANDEX_SKILL_ID`, `YANDEX_SKILL_OAUTH_TOKEN`. If either is empty, notifications are logged and skipped (no error thrown).
