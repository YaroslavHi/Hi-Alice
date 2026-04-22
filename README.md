# HI SmartBox — Alice Adapter

Yandex Smart Home API adapter for the HI SmartBox platform.

Implements the [Yandex Smart Home REST API](https://yandex.ru/dev/dialogs/smart-home/doc/en/reference/) as a **Cloud Control Plane** boundary between Yandex Alice and the P4 owner runtime.

> **Architecture principle:** This service NEVER owns device state. All device control flows through P4 (owner runtime). This service handles OAuth, discovery translation, and intent relay only.

---

## Implemented Stages

| Stage | Endpoint | Status |
|-------|----------|--------|
| **A2** | OAuth 2.0 foundation, account linking, token validation | Done |
| **A3** | `GET /v1.0/user/devices` — device discovery | Done |
| **A4** | `POST /v1.0/user/devices/query` — state query | Done |
| **A5** | `POST /v1.0/user/unlink` — account unlink | Done |
| **A6** | `POST /v1.0/user/devices/action` — device action | Done |
| **A7** | P4 relay client (`services/p4.service.ts`) | Done |
| **A8** | State change notifications → Yandex callback API | Done |

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
│  │  AES-256-GCM   │  │ client   │  │ Yandex callback +    │ │
│  │  + Redis cache  │  │          │  │ retry                │ │
│  └────────────────┘  └──────────┘  └──────────────────────┘ │
│                                                              │
│  PostgreSQL                  Redis                           │
│  (OAuth tokens, audit)       (token L1 cache)               │
└──────────────────────────────────────────────────────────────┘
         │                              ▲
         │ HTTP + P4_RELAY_TOKEN        │ state events
         ▼                              │
   P4 Relay (Node-RED) ─────────────────┘
         │
         │ MQTT TLS (mqtts://:8883)
         ▼
   HI SmartBox Controller ← authoritative device state
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
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `REDIS_PASSWORD` | No | Redis auth password |
| `YANDEX_CLIENT_ID` | Yes | Client ID from Yandex Developer Console |
| `YANDEX_CLIENT_SECRET` | Yes | Client secret (min 16 chars) |
| `HI_LOGIN_URL` | Yes | HI auth login page URL |
| `SERVICE_BASE_URL` | Yes | Public base URL of this service |
| `TOKEN_ENCRYPTION_KEY` | Yes | 64 hex chars (32 bytes) — AES-256-GCM key for token at-rest encryption |
| `TOKEN_HMAC_KEY` | Yes | 64 hex chars (32 bytes) — HMAC-SHA256 key for token lookup index |
| `P4_RELAY_URL` | Yes | Internal URL of P4 relay service |
| `P4_RELAY_TOKEN` | Yes | Auth token for P4 relay |
| `YANDEX_SKILL_ID` | Yes (A8) | Yandex skill ID for callbacks |
| `YANDEX_SKILL_OAUTH_TOKEN` | Yes (A8) | Yandex skill OAuth token for callbacks |
| `YANDEX_REDIRECT_URI_ALLOWLIST` | No | Comma-separated allowed OAuth redirect URIs |
| `ACCESS_TOKEN_TTL_SECONDS` | No | Default: 2592000 (30 days) |
| `REFRESH_TOKEN_TTL_SECONDS` | No | Default: 7776000 (90 days) |
| `AUTH_CODE_TTL_SECONDS` | No | Default: 600 (10 min) |
| `P4_RELAY_TIMEOUT_MS` | No | Default: 8000 ms |
| `RATE_LIMIT_MAX` | No | Default: 100 requests per window |
| `RATE_LIMIT_WINDOW_MS` | No | Default: 60000 ms |
| `LOG_LEVEL` | No | Default: `info` |
| `PORT` | No | Default: `3000` |

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
curl -i https://alice.prosto-test.ru/v1.0
# HTTP/1.1 200 OK

curl -i -X HEAD https://alice.prosto-test.ru/v1.0
# HTTP/1.1 200 OK
```

### OAuth — Account Linking

```bash
# Step 1: Yandex redirects user here
# GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...
# → 302 → HI Login

# Step 2: Exchange code for tokens
curl -X POST https://alice.prosto-test.ru/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://social.yandex.net/broker/redirect"

# Response:
# { "access_token": "...", "token_type": "Bearer",
#   "expires_in": 2592000, "refresh_token": "..." }
```

### Device Discovery

```bash
curl -X GET https://alice.prosto-test.ru/v1.0/user/devices \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)"
```

### Device State Query

```bash
curl -X POST https://alice.prosto-test.ru/v1.0/user/devices/query \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "devices": [
      { "id": "hi:sb-00A3F2:relay-42",
        "custom_data": { "house_id": "sb-00A3F2", "logical_device_id": "relay-42" } }
    ]
  }'
```

### Device Action

```bash
curl -X POST https://alice.prosto-test.ru/v1.0/user/devices/action \
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
              "state": { "instance": "on", "value": true } }
          ]
        }
      ]
    }
  }'
```

### Account Unlink

```bash
curl -X POST https://alice.prosto-test.ru/v1.0/user/unlink \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)"

# Response: { "request_id": "..." }
```

### Internal: P4 State Change Webhook

```bash
curl -X POST https://alice.prosto-test.ru/internal/p4/state-change \
  -H "Authorization: Bearer P4_RELAY_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "house_id": "sb-00A3F2",
    "yandex_user_id": "yandex_uid_123",
    "logical_device_id": "relay-42",
    "kind": "relay",
    "online": true,
    "properties": [
      { "key": "on", "value": true, "updated_at": "2026-04-22T10:30:00Z" }
    ]
  }'

# Response: 202 Accepted — notification queued to Yandex callback API
```

---

## Supported Device Types

13 semantic profiles covering the full HI SmartBox device range:

| Profile                   | Yandex Type                      | Examples                        |
|---------------------------|----------------------------------|---------------------------------|
| `light.relay`             | `devices.types.light`            | relay, switch (light semantics) |
| `socket.relay`            | `devices.types.socket`           | relay, switch (socket semantics)|
| `light.dimmer`            | `devices.types.light`            | dimmer, pwm, pwm_rgb, dali      |
| `curtain.cover`           | `devices.types.openable.curtain` | curtains                        |
| `climate.thermostat.basic`| `devices.types.thermostat`       | climate_control                 |
| `hvac.fan`                | `devices.types.thermostat.ac`    | turkov, fancoil (fan speed)     |
| `thermostat.floor`        | `devices.types.thermostat`       | sensords8 (floor heating)       |
| `actuator.valve`          | `devices.types.openable.valve`   | aqua_protect (water valve)      |
| `sensor.climate.basic`    | `devices.types.sensor.climate`   | ds18b20, dht_temp, dht_humidity |
| `sensor.voltage.basic`    | `devices.types.sensor`           | adc                             |
| `sensor.motion.basic`     | `devices.types.sensor.motion`    | discrete (motion)               |
| `sensor.door.basic`       | `devices.types.sensor.door`      | discrete (door)                 |
| `sensor.button.basic`     | `devices.types.sensor.button`    | discrete (button)               |

See [docs/mapping.md](docs/mapping.md) for the full kind → profile → Yandex type matrix.

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
├── discovery.md                 # Discovery endpoint behavior + full device table
├── oauth.md                     # OAuth 2.0 flow details
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
- [docs/discovery.md](docs/discovery.md) — Discovery endpoint behavior and all device types
- [docs/oauth.md](docs/oauth.md) — OAuth 2.0 flow and security properties
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker deployment guide
