# HI SmartBox — Alice Adapter

Yandex Smart Home API adapter for the HI SmartBox platform.

Implements the [Yandex Smart Home REST API](https://yandex.ru/dev/dialogs/smart-home/doc/en/reference/) as a **Cloud Control Plane** boundary between Yandex Alice and the HI P4 owner runtime.

> **Architecture principle:** This service NEVER owns device state. Device *definitions* (names, rooms, kinds) live in PostgreSQL. Device *state* (current values) is read from P4 relay on demand. All control flows through P4.

---

## Implemented Stages

| Stage | Area | Status |
|-------|------|--------|
| **A2** | OAuth 2.0 account linking, token validation | Done |
| **A3** | `GET /v1.0/user/devices` — device discovery | Done |
| **A4** | `POST /v1.0/user/devices/query` — state query | Done |
| **A5** | `POST /v1.0/user/unlink` — account unlink | Done |
| **A6** | `POST /v1.0/user/devices/action` — device action | Done |
| **A7** | P4 relay client, semantic profile system | Done |
| **A8** | State-change notifications → Yandex callback API | Done |
| **A9** | Multi-tenant DB inventory (houses + devices tables) | Done |
| **A10** | Admin REST API (`/admin/v1/*`) | Done |
| **A11** | Built-in login page (`/login`) | Done |

---

## Architecture

```
                         alice-adapter
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Yandex Smart Home surface                                           │
│  GET  /v1.0                        ← health                         │
│  GET  /v1.0/user/devices           ← discovery (A3)                 │
│  POST /v1.0/user/devices/query     ← state query (A4)               │
│  POST /v1.0/user/devices/action    ← device action (A6)             │
│  POST /v1.0/user/unlink            ← unlink (A5)                    │
│                                                                      │
│  OAuth 2.0 (account linking)                                         │
│  GET  /oauth/authorize                                               │
│  GET  /oauth/callback                                                │
│  POST /oauth/token                                                   │
│  GET  /login  (built-in login page — HI_LOGIN_URL can point here)   │
│  POST /login                                                         │
│                                                                      │
│  Internal webhooks (P4 relay → adapter)                              │
│  POST /internal/p4/state-change          ← full state payload        │
│  POST /internal/p4/house-state-change    ← house_id only (DB lookup) │
│  POST /internal/p4/discovery-change      ← inventory changed         │
│                                                                      │
│  Admin API (X-Admin-Key)                                             │
│  POST   /admin/v1/houses                 ← create house              │
│  GET    /admin/v1/houses                 ← list houses               │
│  GET    /admin/v1/houses/:id             ← get house                 │
│  PATCH  /admin/v1/houses/:id             ← update house              │
│  DELETE /admin/v1/houses/:id             ← delete house              │
│  GET    /admin/v1/houses/:id/devices     ← list devices              │
│  POST   /admin/v1/houses/:id/devices     ← upsert device             │
│  POST   /admin/v1/houses/:id/devices/bulk← bulk upsert               │
│  PATCH  /admin/v1/houses/:id/devices/:d  ← update device             │
│  DELETE /admin/v1/houses/:id/devices/:d  ← delete device             │
│  POST   /admin/v1/auth/verify            ← verify credentials        │
│                                                                      │
│  ┌──────────────────┐  ┌──────────┐  ┌──────────────────────────┐  │
│  │   Token Service   │  │ P4 Relay │  │  Notification Service    │  │
│  │   AES-256-GCM    │  │  client  │  │  Yandex callback + retry │  │
│  │   + Redis cache   │  │          │  │                          │  │
│  └──────────────────┘  └──────────┘  └──────────────────────────┘  │
│                                                                      │
│  PostgreSQL                          Redis                           │
│  · houses (credentials, MQTT config) · token L1 cache               │
│  · devices (names, rooms, kinds)     · notification dedup            │
│  · alice_account_links (OAuth)       · notification queue            │
│  · oauth_auth_codes                                                  │
│  · alice_audit_log                                                   │
└──────────────────────────────────────────────────────────────────────┘
         │                                    ▲
         │ HTTP + P4_RELAY_TOKEN              │ state events
         │ (state/action only)                │ (changed values only)
         ▼                                    │
   P4 Relay (Node-RED) ──────────────────────┘
         │
         │ MQTT TLS (mqtts://:8883)
         ▼
   HI SmartBox Controller ← authoritative device state
```

**Data flow for discovery/query/action:**
- Device *definitions* (name, room, kind, semantics, meta) → read from `devices` table in PostgreSQL
- Device *state* (on/off, temperature, brightness) → queried from P4 relay at request time
- DB error during discovery → graceful degradation: returns empty device list with 200

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
| `HI_LOGIN_URL` | Yes | HI auth login page URL (can be `{SERVICE_BASE_URL}/login`) |
| `SERVICE_BASE_URL` | Yes | Public base URL of this service |
| `TOKEN_ENCRYPTION_KEY` | Yes | 64 hex chars (32 bytes) — AES-256-GCM key |
| `TOKEN_HMAC_KEY` | Yes | 64 hex chars (32 bytes) — HMAC-SHA256 key |
| `P4_RELAY_URL` | Yes | Internal URL of P4 relay service |
| `P4_RELAY_TOKEN` | Yes | Auth token for P4 relay (Bearer) |
| `ADMIN_API_KEY` | Yes | Admin API key (min 32 chars) for `/admin/v1/*` |
| `YANDEX_SKILL_ID` | Yes (A8) | Yandex skill ID for callback notifications |
| `YANDEX_SKILL_OAUTH_TOKEN` | Yes (A8) | Yandex skill OAuth token for callbacks |
| `YANDEX_REDIRECT_URI_ALLOWLIST` | No | Comma-separated allowed OAuth redirect URIs |
| `ACCESS_TOKEN_TTL_SECONDS` | No | Default: 2592000 (30 days) |
| `REFRESH_TOKEN_TTL_SECONDS` | No | Default: 7776000 (90 days) |
| `AUTH_CODE_TTL_SECONDS` | No | Default: 600 (10 min) |
| `NOTIFICATION_DEDUP_TTL_SECONDS` | No | Default: 30 (seconds) |
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
npm run migrate   # apply DB schema (creates all 5 tables)
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
```

### OAuth — Account Linking

```bash
# Exchange code for tokens
curl -X POST https://alice.prosto-test.ru/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=AUTH_CODE&client_id=ID&client_secret=SECRET&redirect_uri=https://social.yandex.net/broker/redirect"
```

### Built-in Login Page

```
GET /login?redirect_back=...&yandex_redirect=...&yandex_state=...
POST /login  (form: login, password + hidden OAuth params)
```

Set `HI_LOGIN_URL=https://alice.prosto-test.ru/login` to use the built-in page instead of an external auth service.

### Device Discovery

```bash
curl https://alice.prosto-test.ru/v1.0/user/devices \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)"
```

### Device State Query

```bash
curl -X POST https://alice.prosto-test.ru/v1.0/user/devices/query \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"devices": [{"id": "hi:sb-00A3F2:relay-42", "custom_data": {"house_id": "sb-00A3F2", "logical_device_id": "relay-42"}}]}'
```

### Device Action

```bash
curl -X POST https://alice.prosto-test.ru/v1.0/user/devices/action \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "X-Request-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"devices": [{"id": "hi:sb-00A3F2:relay-42", "capabilities": [{"type": "devices.capabilities.on_off", "state": {"instance": "on", "value": true}}]}]}}'
```

### Internal: P4 State Change Webhooks

```bash
# Full payload (P4 relay knows the Yandex user ID)
curl -X POST https://alice.prosto-test.ru/internal/p4/state-change \
  -H "Authorization: Bearer P4_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "house_id": "sb-00A3F2",
    "yandex_user_id": "yandex_uid_123",
    "logical_device_id": "relay-42",
    "kind": "relay",
    "online": true,
    "properties": [{"key": "on", "value": true, "updated_at": "2026-04-22T10:30:00Z"}]
  }'

# House-scoped (adapter looks up yandex_user_id from alice_account_links)
curl -X POST https://alice.prosto-test.ru/internal/p4/house-state-change \
  -H "Authorization: Bearer P4_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "house_id": "sb-00A3F2",
    "logical_device_id": "relay-42",
    "kind": "relay",
    "online": true,
    "properties": [{"key": "on", "value": true, "updated_at": "2026-04-22T10:30:00Z"}]
  }'

# Both return 202 Accepted
```

### Admin API

```bash
ADMIN_KEY="your-admin-api-key"

# Create a house
curl -X POST https://alice.prosto-test.ru/admin/v1/houses \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "house_id": "sb-00A3F2",
    "display_name": "Офис на Тверской",
    "owner_login": "office-admin",
    "owner_password": "securepassword",
    "mqtt_broker_url": "mqtts://mymqtt.ru:8883"
  }'

# Add / update a device
curl -X POST https://alice.prosto-test.ru/admin/v1/houses/sb-00A3F2/devices \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "logical_device_id": "switch_903858",
    "kind": "relay",
    "semantics": "light",
    "name": "Офисный свет",
    "room": "Офис"
  }'

# Bulk upsert devices (replaces all existing if replace=true)
curl -X POST https://alice.prosto-test.ru/admin/v1/houses/sb-00A3F2/devices/bulk \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"devices": [...], "replace": false}'

# Verify house credentials
curl -X POST https://alice.prosto-test.ru/admin/v1/auth/verify \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"login": "office-admin", "password": "securepassword"}'
```

---

## Supported Device Types

13 semantic profiles covering the full HI SmartBox device range:

| Profile                    | Yandex Type                      | P4 Kinds                        |
|----------------------------|----------------------------------|---------------------------------|
| `light.relay`              | `devices.types.light`            | relay (semantics=light)         |
| `socket.relay`             | `devices.types.socket`           | relay (semantics=socket)        |
| `light.dimmer`             | `devices.types.light`            | dimmer, pwm, pwm_rgb, dali, dali_group |
| `curtain.cover`            | `devices.types.openable.curtain` | curtains                        |
| `climate.thermostat.basic` | `devices.types.thermostat`       | climate_control                 |
| `hvac.fan`                 | `devices.types.thermostat.ac`    | fancoil (fan speed)             |
| `thermostat.floor`         | `devices.types.thermostat`       | sensords8 (floor heating)       |
| `actuator.valve`           | `devices.types.openable.valve`   | aqua_protect                    |
| `sensor.climate.basic`     | `devices.types.sensor.climate`   | ds18b20, dht_temp, dht_humidity |
| `sensor.voltage.basic`     | `devices.types.sensor`           | adc                             |
| `sensor.motion.basic`      | `devices.types.sensor.motion`    | discrete (motion semantics)     |
| `sensor.door.basic`        | `devices.types.sensor.door`      | discrete (door semantics)       |
| `sensor.button.basic`      | `devices.types.sensor.button`    | discrete (button semantics)     |

---

## File Structure

```
src/
├── config/env.ts                  # Zod-validated env config (fails fast at startup)
├── types/
│   ├── yandex.ts                  # Yandex Smart Home REST API types
│   └── internal.ts                # Domain types: HouseRecord, DeviceRecord, ValidatedToken, intents
├── semantics/
│   └── profiles.ts                # Semantic profile resolution + v1 allowlist (13 profiles)
├── db/
│   ├── client.ts                  # Fastify PostgreSQL plugin (postgres.camel transform)
│   └── schema.sql                 # 5-table schema: houses, devices, alice_account_links, ...
├── plugins/
│   ├── redis.ts                   # Fastify Redis plugin
│   ├── request-id.ts              # X-Request-Id propagation
│   └── metrics.ts                 # Prometheus counters/histograms
├── middleware/
│   └── auth.ts                    # Bearer token validation (Redis L1 → DB HMAC)
├── services/
│   ├── token.service.ts           # Token lifecycle: issue, validate, rotate, unlink
│   ├── crypto.service.ts          # AES-256-GCM encryption + HMAC-SHA256
│   ├── house.service.ts           # houses + devices CRUD, password hashing (scrypt)
│   ├── p4.service.ts              # P4 relay HTTP client (state query, action)
│   └── notification.service.ts    # Yandex callback queue + retry worker
├── mappers/
│   ├── device.mapper.ts           # Semantic profile → Yandex device (discovery)
│   ├── state.mapper.ts            # P4 state properties → Yandex capability states
│   └── action.mapper.ts           # Yandex capability actions → P4 DeviceSetIntent
├── controllers/
│   ├── health.controller.ts       # GET|HEAD /v1.0
│   ├── oauth.controller.ts        # /oauth/authorize, /callback, /token
│   ├── login.controller.ts        # GET|POST /login (built-in login page)
│   ├── unlink.controller.ts       # POST /v1.0/user/unlink
│   ├── discovery.controller.ts    # GET /v1.0/user/devices  (inventory from DB)
│   ├── query.controller.ts        # POST /v1.0/user/devices/query (inventory from DB, state from P4)
│   ├── action.controller.ts       # POST /v1.0/user/devices/action (inventory from DB, action via P4)
│   ├── p4-webhook.controller.ts   # POST /internal/p4/{state-change,house-state-change,discovery-change}
│   ├── admin.controller.ts        # Admin CRUD: /admin/v1/houses + /admin/v1/houses/:id/devices
│   └── metrics.controller.ts      # GET /metrics (Prometheus)
├── routes/index.ts                # Central route registration
├── app.ts                         # Fastify app factory
└── index.ts                       # Entry point + graceful shutdown

docs/
├── oauth.md                       # OAuth 2.0 flow and security properties
├── notifications.md               # Notification queue, delivery, webhook endpoints
├── observability.md               # Metrics and logging
└── admin-api.md                   # Admin API reference

nodered/
└── flows.json                     # Node-RED flows: MQTT monitor, tester, Real Controller Relay
                                   # (fn-cache-state: change detection → /internal/p4/house-state-change)
scripts/
└── migrate.js                     # Apply src/db/schema.sql to PostgreSQL
```

---

## Database Schema

5 tables in PostgreSQL:

| Table | Purpose |
|-------|---------|
| `houses` | SmartBox controller instances — credentials, MQTT config |
| `devices` | Device inventory per house — name, room, kind, semantics, meta |
| `alice_account_links` | OAuth account links — encrypted tokens, HMAC index |
| `oauth_auth_codes` | Short-lived auth codes (10 min TTL) |
| `alice_audit_log` | Append-only security audit trail |

Apply with: `docker compose exec alice-adapter npm run migrate`

---

## Docs

- [docs/oauth.md](docs/oauth.md) — OAuth 2.0 flow and security properties
- [docs/notifications.md](docs/notifications.md) — Notification queue and delivery
- [docs/admin-api.md](docs/admin-api.md) — Admin REST API reference
- [docs/observability.md](docs/observability.md) — Metrics and logging
