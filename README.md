# HI SmartBox — Alice Adapter

Yandex Smart Home API adapter for the HI SmartBox platform.

Implements the [Yandex Smart Home REST API](https://yandex.ru/dev/dialogs/smart-home/doc/en/reference/) as a **Cloud Control Plane** boundary between Yandex Alice and the P4 owner runtime.

> **Architecture principle:** This service NEVER owns device state. All device control flows through P4 (owner runtime). This service handles OAuth, discovery translation, and intent relay only.

---

## Implemented Stages

| Stage | Endpoint | Status |
|-------|----------|--------|
| **A2** | OAuth 2.0 foundation, account linking, token validation | ✅ Done |
| **A3** | `GET /v1.0/user/devices` — device discovery | ✅ Done |
| **A4** | `POST /v1.0/user/devices/query` — state query | ✅ Done |
| **A5** | `POST /v1.0/user/unlink` — account unlink | ✅ Done |
| **A6** | `POST /v1.0/user/devices/action` — device action | ✅ Done |
| **A7** | P4 relay client (`services/p4.service.ts`) | ✅ Done |
| **A8** | State change notifications → Yandex callback API | ✅ Done |

---

## Architecture

```
                         alice-adapter
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Yandex Smart Home surface                                   │
│  GET  /v1.0                    ← health                      │
│  GET  /v1.0/user/devices       ← discovery (A3)             │
│  POST /v1.0/user/devices/query ← state query (A4)           │
│  POST /v1.0/user/devices/action← device action (A6)         │
│  POST /v1.0/user/unlink        ← unlink (A5)                │
│                                                              │
│  OAuth 2.0 (account linking)                                 │
│  GET  /oauth/authorize                                       │
│  GET  /oauth/callback                                        │
│  POST /oauth/token                                           │
│                                                              │
│  Internal (relay → adapter)                                  │
│  POST /internal/p4/state-change← P4 state events (A8)       │
│                                                              │
│  ┌────────────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │  Token Service  │  │ P4 Relay │  │ Notification Service │ │
│  │  argon2 + Redis │  │ client   │  │ Yandex callback +    │ │
│  │  cache          │  │          │  │ retry                │ │
│  └────────────────┘  └──────────┘  └──────────────────────┘ │
│                                                              │
│  PostgreSQL                  Redis                           │
│  (OAuth tokens, audit)       (token L1 cache)               │
└──────────────────────────────────────────────────────────────┘
         │                              ▲
         │ HTTP + P4_RELAY_TOKEN        │ state events
         ▼                              │
   P4 Relay Service ────────────────────┘
         │
         │ MQTT / WebSocket
         ▼
   ESP32-P4 (owner runtime) ← authoritative device state
```

---

## Requirements

- Node.js ≥ 20
- PostgreSQL 15+
- Redis 7+

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `YANDEX_CLIENT_ID` | ✅ | Client ID from Yandex Developer Console |
| `YANDEX_CLIENT_SECRET` | ✅ | Client secret (min 16 chars) |
| `HI_LOGIN_URL` | ✅ | HI auth login page URL |
| `SERVICE_BASE_URL` | ✅ | Public base URL of this service |
| `TOKEN_PEPPER` | ✅ | 32+ hex bytes for argon2 pepper |
| `P4_RELAY_URL` | ✅ | Internal URL of P4 relay service |
| `P4_RELAY_TOKEN` | ✅ | Auth token for P4 relay |
| `YANDEX_SKILL_ID` | ✅ (A8) | Yandex skill ID for callbacks |
| `YANDEX_SKILL_OAUTH_TOKEN` | ✅ (A8) | Yandex skill OAuth token for callbacks |
| `ACCESS_TOKEN_TTL_SECONDS` | ❌ | Default: 2592000 (30 days) |
| `REFRESH_TOKEN_TTL_SECONDS` | ❌ | Default: 7776000 (90 days) |
| `AUTH_CODE_TTL_SECONDS` | ❌ | Default: 600 (10 min) |
| `P4_RELAY_TIMEOUT_MS` | ❌ | Default: 8000 ms |
| `LOG_LEVEL` | ❌ | Default: `info` |
| `PORT` | ❌ | Default: `3000` |

---

## Running

### Development

```bash
cp .env.example .env
# Fill in .env values

npm install
npm run migrate   # apply DB schema
npm run dev       # tsx watch
```

### Production (Docker)

```bash
cp .env.example .env
# Fill in .env values

docker compose up -d
docker compose exec alice-adapter npm run migrate
```

---

## API Reference

### Health

```bash
curl -i https://alice.h-i.space/v1.0
# HTTP/1.1 200 OK

curl -i -X HEAD https://alice.h-i.space/v1.0
# HTTP/1.1 200 OK
```

### OAuth — Account Linking

```bash
# Step 1: Yandex redirects user here
# GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...
# → 302 → HI Login

# Step 2: Exchange code for tokens
curl -X POST https://alice.h-i.space/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://social.yandex.net/broker/redirect"

# Response:
# { "access_token": "...", "token_type": "Bearer",
#   "expires_in": 2592000, "refresh_token": "..." }

# Refresh:
curl -X POST https://alice.h-i.space/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=YOUR_REFRESH_TOKEN" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

### Device Discovery

```bash
curl -X GET https://alice.h-i.space/v1.0/user/devices \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)"

# Response:
# {
#   "request_id": "...",
#   "payload": {
#     "user_id": "yandex_uid_123",
#     "devices": [
#       {
#         "id": "hi:sb-00A3F2:relay-42",
#         "name": "Люстра в гостиной",
#         "type": "devices.types.light",
#         "room": "Гостиная",
#         "capabilities": [
#           { "type": "devices.capabilities.on_off",
#             "retrievable": true, "reportable": true,
#             "parameters": { "split": false } },
#           { "type": "devices.capabilities.range",
#             "retrievable": true, "reportable": true,
#             "parameters": { "instance": "brightness",
#               "random_access": true, "range": { "min": 0, "max": 100, "precision": 1 } } }
#         ],
#         "properties": [],
#         "device_info": { "manufacturer": "HI SmartBox", "model": "dimmer" }
#       }
#     ]
#   }
# }
```

### Device State Query

```bash
curl -X POST https://alice.h-i.space/v1.0/user/devices/query \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "devices": [
      { "id": "hi:sb-00A3F2:relay-42",
        "custom_data": { "kind": "dimmer", "house_id": "sb-00A3F2",
                         "logical_device_id": "relay-42" } }
    ]
  }'

# Response:
# {
#   "request_id": "...",
#   "payload": {
#     "devices": [
#       {
#         "id": "hi:sb-00A3F2:relay-42",
#         "capabilities": [
#           { "type": "devices.capabilities.on_off",
#             "state": { "instance": "on", "value": true },
#             "last_updated": 1712234567 },
#           { "type": "devices.capabilities.range",
#             "state": { "instance": "brightness", "value": 75 },
#             "last_updated": 1712234560 }
#         ],
#         "properties": []
#       }
#     ]
#   }
# }
```

### Device Action

```bash
# Turn on and set brightness to 80%
curl -X POST https://alice.h-i.space/v1.0/user/devices/action \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "devices": [
        {
          "id": "hi:sb-00A3F2:relay-42",
          "capabilities": [
            { "type": "devices.capabilities.on_off",
              "state": { "instance": "on", "value": true } },
            { "type": "devices.capabilities.range",
              "state": { "instance": "brightness", "value": 80 } }
          ]
        }
      ]
    }
  }'

# Response (after P4 owner-confirms hardware execution):
# {
#   "request_id": "...",
#   "payload": {
#     "devices": [
#       {
#         "id": "hi:sb-00A3F2:relay-42",
#         "capabilities": [
#           { "type": "devices.capabilities.on_off",
#             "state": { "instance": "on",
#                        "action_result": { "status": "DONE" } } },
#           { "type": "devices.capabilities.range",
#             "state": { "instance": "brightness",
#                        "action_result": { "status": "DONE" } } }
#         ]
#       }
#     ]
#   }
# }
```

### Account Unlink

```bash
curl -X POST https://alice.h-i.space/v1.0/user/unlink \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)"

# Response: { "request_id": "..." }
```

### Internal: P4 State Change Webhook

```bash
# Called by P4 relay when device state changes on P4 board
curl -X POST https://alice.h-i.space/internal/p4/state-change \
  -H "Authorization: Bearer P4_RELAY_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "house_id": "sb-00A3F2",
    "yandex_user_id": "yandex_uid_123",
    "logical_device_id": "relay-42",
    "kind": "dimmer",
    "online": true,
    "properties": [
      { "key": "on", "value": true, "updated_at": "2026-04-21T10:30:00Z" },
      { "key": "brightness", "value": 80, "updated_at": "2026-04-21T10:30:00Z" }
    ]
  }'

# Response: 202 Accepted — notification queued to Yandex callback API
```

---

## File Structure

```
src/
├── config/env.ts                # Zod-validated env config (fails fast at startup)
├── types/
│   ├── yandex.ts                # Yandex Smart Home REST API types
│   └── internal.ts              # Internal domain types (ValidatedToken, intents, P4 state)
├── semantics/
│   └── profiles.ts              # Semantic profile resolution + v1 allowlist (CRITICAL)
├── db/
│   ├── client.ts                # Fastify PostgreSQL plugin
│   └── schema.sql               # 3-table OAuth schema
├── plugins/
│   ├── redis.ts                 # Fastify Redis plugin
│   ├── request-id.ts            # X-Request-Id propagation
│   └── metrics.ts               # Prometheus counters/histograms
├── middleware/
│   └── auth.ts                  # Bearer token validation (Redis L1 → DB HMAC)
├── services/
│   ├── token.service.ts         # Token lifecycle: issue, validate, rotate, unlink
│   ├── crypto.service.ts        # AES-256-GCM encryption + HMAC-SHA256
│   ├── p4.service.ts            # P4 relay HTTP client (inventory, state, action)
│   └── notification.service.ts  # Yandex callback queue + retry worker
├── mappers/
│   ├── device.mapper.ts         # Semantic profile → Yandex device (discovery)
│   ├── state.mapper.ts          # P4 state properties → Yandex capability states
│   └── action.mapper.ts         # Yandex capability actions → P4 DeviceSetIntent
├── controllers/
│   ├── health.controller.ts     # GET|HEAD /v1.0
│   ├── oauth.controller.ts      # /oauth/authorize, /callback, /token
│   ├── unlink.controller.ts     # POST /v1.0/user/unlink
│   ├── discovery.controller.ts  # GET /v1.0/user/devices
│   ├── query.controller.ts      # POST /v1.0/user/devices/query
│   ├── action.controller.ts     # POST /v1.0/user/devices/action
│   ├── p4-webhook.controller.ts # POST /internal/p4/state-change
│   └── metrics.controller.ts    # GET /metrics (Prometheus)
├── routes/index.ts              # Central route registration
├── app.ts                       # Fastify app factory
└── index.ts                     # Entry point + graceful shutdown

docs/
├── architecture.md              # System design, semantic profiles, token model
├── mapping.md                   # Complete P4 kind → profile → Yandex type matrix
├── oauth.md                     # OAuth 2.0 flow details
├── discovery.md                 # Discovery endpoint behavior
├── notifications.md             # Notification queue and delivery
├── observability.md             # Metrics and logging
├── testing.md                   # Test strategy
└── DEPLOYMENT.md                # Docker deployment guide

scripts/
└── migrate.js                   # Apply src/db/schema.sql to PostgreSQL
```

---

## Docs

- [docs/architecture.md](docs/architecture.md) — System design, semantic profiles, token security model
- [docs/mapping.md](docs/mapping.md) — Complete P4 kind → semantic profile → Yandex type matrix
- [docs/oauth.md](docs/oauth.md) — OAuth 2.0 flow and security properties
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker deployment guide

