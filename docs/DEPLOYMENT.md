# Deployment Guide

## Overview

The HI Alice Adapter stack:

```
alice-adapter   — Fastify app, Yandex Smart Home API
postgres        — houses, devices, OAuth tokens
redis           — token cache + notification queue
mock-p4         — P4 relay simulator (replace with real relay in production)
mosquitto       — MQTT broker for real controller
nodered         — MQTT monitor + state-change detection
```

Device inventory lives in PostgreSQL. The P4 relay only provides **live state and action execution** — it does NOT define what devices exist.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| Docker 24+ with Compose plugin | `docker compose` (not `docker-compose`) |
| Public HTTPS domain | Yandex requires valid TLS |
| Yandex Developer Console account | [dialogs.yandex.ru](https://dialogs.yandex.ru/developer) |

No Node.js on the host required.

---

## 2. Yandex Developer Console — Skill Setup

1. Create new skill → **Smart Home**
2. **Endpoint URL**: `https://alice.your-domain.com` (NO `/v1.0` — Yandex adds it)
3. **OAuth login URL**: `https://alice.your-domain.com/oauth/authorize`
4. **Token URL**: `https://alice.your-domain.com/oauth/token`
5. Copy **Client ID** and **Client Secret** → `.env`
6. Skill ID is in the URL: `dialogs.yandex.ru/developer/skills/da1d45da-xxx/edit`

---

## 3. First Deployment

### 3.1 Clone and prepare

```bash
git clone https://github.com/YaroslavHi/Hi-Alice.git /opt/Hi-Alice
cd /opt/Hi-Alice
cp .env.example .env
```

### 3.2 Generate keys

```bash
node -e "
  const c = require('crypto');
  console.log('TOKEN_ENCRYPTION_KEY=' + c.randomBytes(32).toString('hex'));
  console.log('TOKEN_HMAC_KEY='       + c.randomBytes(32).toString('hex'));
  console.log('ADMIN_API_KEY='        + c.randomBytes(32).toString('hex'));
  console.log('P4_RELAY_TOKEN='       + c.randomBytes(24).toString('hex'));
  console.log('POSTGRES_PASSWORD='    + c.randomBytes(16).toString('hex'));
"
```

### 3.3 Fill in `.env`

```env
DATABASE_URL=postgresql://alice:YOUR_POSTGRES_PASSWORD@postgres:5432/alice_db
POSTGRES_PASSWORD=YOUR_POSTGRES_PASSWORD

REDIS_URL=redis://redis:6379

YANDEX_CLIENT_ID=your-client-id
YANDEX_CLIENT_SECRET=your-client-secret
YANDEX_SKILL_ID=da1d45da-xxxx-xxxx-xxxx-xxxxxxxxxxxx
YANDEX_SKILL_OAUTH_TOKEN=       # leave empty until skill is published

HI_LOGIN_URL=https://alice.your-domain.com/login
SERVICE_BASE_URL=https://alice.your-domain.com

TOKEN_ENCRYPTION_KEY=<64 hex chars>
TOKEN_HMAC_KEY=<64 hex chars>   # must differ from ENCRYPTION_KEY

ADMIN_API_KEY=<64 hex chars>    # protects /admin/v1/*

P4_RELAY_URL=http://mock-p4:4000   # test: mock-p4 | real: http://nodered:1880
P4_RELAY_TOKEN=<random 32+ chars>
```

### 3.4 Start the stack

```bash
docker compose up -d
```

### 3.5 Apply database schema

```bash
docker compose exec alice-adapter npm run migrate
```

Creates 5 tables: `houses`, `devices`, `alice_account_links`, `oauth_auth_codes`, `alice_audit_log`.

### 3.6 Create a house and add devices

```bash
ADMIN_KEY="your-admin-api-key"
BASE="http://localhost:3000"

# Create house
curl -X POST $BASE/admin/v1/houses \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "house_id":       "sb-00A3F2",
    "display_name":   "My House",
    "owner_login":    "my-login",
    "owner_password": "strong-password",
    "mqtt_broker_url":"mqtts://mymqtt.ru:8883"
  }'

# Add devices (bulk upsert)
curl -X POST $BASE/admin/v1/houses/sb-00A3F2/devices/bulk \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "devices": [
      {"logical_device_id":"switch_903858","kind":"relay","semantics":"light","name":"Офисный свет","room":"Офис","board_id":"controller-01"},
      {"logical_device_id":"ds18b20_155881","kind":"ds18b20","name":"Температура","room":"Офис","board_id":"controller-01"},
      {"logical_device_id":"shtanddht_509766","kind":"dht_temp","name":"Климат","room":"Офис","board_id":"controller-01"}
    ],
    "replace": false
  }'
```

See [docs/admin-api.md](admin-api.md) for full API reference.

### 3.7 Configure nginx

```nginx
server {
    listen 443 ssl;
    server_name alice.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/alice.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.your-domain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}

server {
    listen 80;
    server_name alice.your-domain.com;
    return 301 https://$host$request_uri;
}
```

```bash
certbot --nginx -d alice.your-domain.com
```

**Important:** Do NOT expose ports 3000, 1880, or 5432 publicly.

### 3.8 Verify

```bash
curl https://alice.your-domain.com/v1.0
# → {"status":"ok"}

curl https://alice.your-domain.com/login?redirect_back=https://example.com&yandex_redirect=https://yandex.com&yandex_state=test
# → 200 HTML form
```

### 3.9 Link account in Alice

1. Яндекс app → Устройства → Добавить → Умный дом → HI SmartBox
2. Login with `owner_login` / `owner_password` at `https://alice.your-domain.com/login`
3. Alice discovers all devices from the `devices` table

---

## 4. P4 Relay Configuration

`P4_RELAY_URL` decides where device state and actions go:

| Mode | URL | Use when |
|------|-----|----------|
| Test (mock-p4) | `http://mock-p4:4000` | Development and testing |
| Real controller (Node-RED) | `http://nodered:1880` | Production with real hardware |

The P4 relay must implement:
```
POST /internal/v1/houses/{house_id}/devices/state   — returns device states
POST /internal/v1/houses/{house_id}/devices/action  — executes action
```
Auth: `Authorization: Bearer {P4_RELAY_TOKEN}`

**Note:** Inventory (device names, kinds, rooms) is now stored in the `devices` DB table and NOT fetched from the P4 relay.

---

## 5. Node-RED Setup

Node-RED (`nodered` service) provides:
- **MQTT Monitor** — live device state from MQTT broker
- **State-Change Tester** — manual injection for testing
- **Real Controller Relay** — MQTT change detection → alice-adapter notification

### 5.1 Environment variables (set in `docker-compose.yml`)

```yaml
nodered:
  environment:
    - NODE_RED_ENABLE_PROJECTS=false
    - HOUSE_ID=sb-00A3F2          # house_id from houses table
    - ALICE_ADAPTER_URL=http://alice-adapter:3000
    - P4_RELAY_TOKEN=your-token   # same as alice-adapter's P4_RELAY_TOKEN
```

When a controller publishes state to MQTT, `fn-cache-state` in Node-RED detects changes and POSTs to `/internal/p4/house-state-change` on alice-adapter, which triggers a Yandex push notification.

### 5.2 Discover MQTT device IDs

Open Node-RED editor at `http://your-server:1880` → **MQTT Monitor** tab.
Topics follow: `demo/v1/server/devices/{device_id}/{field}`

### 5.3 Add real controller devices to DB

After observing MQTT topics, add devices via Admin API:

```bash
curl -X POST $BASE/admin/v1/houses/sb-00A3F2/devices \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "logical_device_id": "switch_903858",
    "kind": "relay",
    "semantics": "light",
    "name": "Офисный свет",
    "room": "Офис"
  }'
```

---

## 6. Updates

```bash
cd /opt/Hi-Alice
git pull
docker compose build alice-adapter
docker compose exec alice-adapter npm run migrate   # only if schema changed
docker compose up -d --force-recreate alice-adapter
```

Node-RED flows update:
```bash
# After editing nodered/flows.json locally:
scp nodered/flows.json user@server:/opt/nodered/flows.json
docker compose restart nodered
```

---

## 7. Observability

```bash
# Adapter logs:
docker compose logs -f alice-adapter

# Key log messages:
# "Discovery response built"    — Yandex requested device list
# "State query completed"       — Yandex polled device states
# "Action request completed"    — Yandex sent a command
# "Device has no v1 semantic profile" — kind+semantics not supported

# Metrics:
curl http://localhost:3000/metrics | grep alice_
```

---

## 8. Pre-production Checklist

- [ ] `TOKEN_ENCRYPTION_KEY` — unique 64-hex random string
- [ ] `TOKEN_HMAC_KEY` — unique 64-hex, different from ENCRYPTION_KEY
- [ ] `ADMIN_API_KEY` — 64-hex random string, store securely
- [ ] `POSTGRES_PASSWORD` — strong random password
- [ ] `P4_RELAY_TOKEN` — strong shared secret (32+ chars)
- [ ] HTTPS certificate valid (not self-signed)
- [ ] `SERVICE_BASE_URL` matches Yandex Console webhook URL exactly
- [ ] `HI_LOGIN_URL` set to `https://alice.your-domain.com/login`
- [ ] Database schema applied (`npm run migrate`)
- [ ] Houses and devices created via Admin API
- [ ] Health endpoint returns 200 (`curl https://alice.your-domain.com/v1.0`)
- [ ] Port 1880 (Node-RED) NOT exposed publicly
- [ ] At least one device visible in Alice after account linking

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "навык недоступен" | `/v1.0` not 200 | `docker compose logs alice-adapter` |
| OAuth redirect fails | `SERVICE_BASE_URL` mismatch | Check `.env` vs Yandex Console |
| No devices in discovery | No devices in DB | Create devices via Admin API |
| Device "недоступно" (DEVICE_UNREACHABLE) | P4 relay returns `online: false` | Check P4_RELAY_URL and relay logs |
| Device "не найдено" (DEVICE_NOT_FOUND) | Device not in `devices` DB table | Add via `POST /admin/v1/houses/:id/devices` |
| Login page 500 | `HI_LOGIN_URL` not set | Set `HI_LOGIN_URL` in `.env` |
| Actions return DEVICE_NOT_FOUND | Device in DB but P4 relay rejects | Check P4_RELAY_TOKEN matches |
| MQTT not connecting | Wrong broker credentials | Node-RED editor → update broker node |
