# Deployment Guide — alice-adapter

## Prerequisites

| Component | Minimum version | Notes |
|-----------|----------------|-------|
| Node.js | 20 LTS | Runtime |
| PostgreSQL | 15 | Self-hosted or managed |
| Redis | 7 | Token L1 cache |
| Docker + Compose | 24 | For containerised deploy |
| Public HTTPS domain | — | Yandex rejects self-signed certs |

---

## Yandex Developer Console Setup

Go to [dialogs.yandex.ru/developer](https://dialogs.yandex.ru/developer) → create skill → **Умный дом**.

### 1. OAuth settings (Авторизация)

| Field | Value |
|-------|-------|
| Authorization endpoint | `https://your-domain.com/oauth/authorize` |
| Token endpoint | `https://your-domain.com/oauth/token` |
| Client ID | choose any string → set as `YANDEX_CLIENT_ID` |
| Client Secret | min 16 chars → set as `YANDEX_CLIENT_SECRET` |
| Redirect URI | Yandex shows it after saving — usually `https://social.yandex.net/broker/redirect` |

> **Important:** the save button in Yandex Dialogs only works when your HTTPS endpoint is reachable. Obtain a TLS certificate before configuring OAuth.

### 2. Backend URL (Настройки → Webhook)

Set the URL to your **base domain only** — **no `/v1.0` suffix**:

```
https://your-domain.com
```

Yandex appends `/v1.0/user/devices`, `/v1.0/user/devices/query`, etc. automatically.  
Setting `https://your-domain.com/v1.0` causes double-prefix: `/v1.0/v1.0/user/devices` → 404.

### 3. Skill credentials for outbound notifications

After saving, note:
- **Skill ID** → `YANDEX_SKILL_ID`
- Generate a **skill OAuth token** → `YANDEX_SKILL_OAUTH_TOKEN`

These are for alice-adapter pushing state changes *to* Yandex (A8), not for account linking.

### Two credential sets — never confuse them

```
YANDEX_CLIENT_ID / SECRET  ← Yandex calls our /oauth/token with these
YANDEX_SKILL_ID / OAUTH_TOKEN ← we call Yandex callback API with these
```

---

## HI Login Stub (test/development only)

In production the `HI_LOGIN_URL` points to the real HI authentication service. For testing, deploy a stub:

```js
// /opt/login-stub/server.js — minimal example
const http = require('http');
const url  = require('url');
const qs   = require('querystring');

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'GET' && parsed.pathname === '/login-stub') {
    const { redirect_back, yandex_redirect, yandex_state } = parsed.query;
    // Serve an HTML form; embed redirect_back, yandex_redirect, yandex_state
    // as hidden fields.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<form method="POST" action="/login-stub">
      <input type="hidden" name="redirect_back"   value="${redirect_back}">
      <input type="hidden" name="yandex_redirect"  value="${yandex_redirect}">
      <input type="hidden" name="yandex_state"     value="${yandex_state}">
      <input name="house_id" value="sb-TEST01">
      <input name="owner"    value="test-owner">
      <button>Login</button>
    </form>`);
  }

  if (req.method === 'POST' && parsed.pathname === '/login-stub') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const { house_id, owner, redirect_back, yandex_redirect, yandex_state } = qs.parse(body);
      const cb = new URL(redirect_back);
      cb.searchParams.set('hi_user_id',          owner);
      cb.searchParams.set('hi_house_id',         house_id);
      cb.searchParams.set('yandex_user_id',      'yandex-uid-' + house_id);
      cb.searchParams.set('yandex_state',        yandex_state);
      cb.searchParams.set('yandex_redirect_uri', yandex_redirect);
      res.writeHead(302, { Location: cb.toString() });
      res.end();
    });
  }
}).listen(3001);
```

The oauth/authorize handler redirects to `HI_LOGIN_URL` with query params:
- `redirect_back` — the callback URL (`SERVICE_BASE_URL/oauth/callback`)
- `yandex_redirect` — Yandex redirect URI
- `yandex_state` — opaque Yandex state string

The callback expects: `hi_user_id`, `hi_house_id`, `yandex_user_id`, `yandex_state`, `yandex_redirect_uri`.

---

## Environment Setup

```bash
cp .env.example .env
# Edit .env
```

| Variable | Required | Where to get |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | ✅ | `redis://host:6379` |
| `YANDEX_CLIENT_ID` | ✅ | Yandex Dialogs → OAuth settings |
| `YANDEX_CLIENT_SECRET` | ✅ | Yandex Dialogs → OAuth settings (min 16 chars) |
| `HI_LOGIN_URL` | ✅ | URL of HI auth login page |
| `SERVICE_BASE_URL` | ✅ | Public HTTPS base URL, e.g. `https://alice.h-i.space` |
| `TOKEN_ENCRYPTION_KEY` | ✅ | 64 hex chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `TOKEN_HMAC_KEY` | ✅ | 64 hex chars (different from encryption key) |
| `P4_RELAY_URL` | ✅ | Internal URL of P4 relay, e.g. `http://p4-relay:4000` |
| `P4_RELAY_TOKEN` | ✅ | Strong random secret shared with P4 relay |
| `YANDEX_SKILL_ID` | ✅ (A8) | Yandex Dialogs → skill ID |
| `YANDEX_SKILL_OAUTH_TOKEN` | ✅ (A8) | Yandex Dialogs → skill OAuth token |
| `YANDEX_REDIRECT_URI_ALLOWLIST` | ❌ | Comma-separated allowed redirect URIs. Default: `https://social.yandex.net/broker/redirect` |

> **Note:** `TOKEN_PEPPER` (mentioned in README) is an alias — use `TOKEN_ENCRYPTION_KEY` and `TOKEN_HMAC_KEY` as two separate keys.

---

## Database Migration

`scripts/migrate.js` contains TypeScript type annotations and cannot be run as plain JavaScript. Apply the schema directly via psql:

```bash
# Via Docker Compose
docker compose exec postgres psql -U alice -d alice_db < src/db/schema.sql

# Or copy then run
docker compose cp src/db/schema.sql postgres:/tmp/schema.sql
docker compose exec postgres psql -U alice -d alice_db -f /tmp/schema.sql
```

The schema is idempotent (`CREATE TABLE IF NOT EXISTS`).

---

## Docker Deployment

### docker-compose.yml

```yaml
services:
  alice-adapter:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - '3000:3000'
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:3000/v1.0', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: alice
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: alice_db
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U alice -d alice_db']
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --save 60 1 --loglevel warning
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres-data:
  redis-data:
```

### Commands

```bash
# First deploy
docker compose build
docker compose up -d
docker compose cp src/db/schema.sql postgres:/tmp/schema.sql
docker compose exec postgres psql -U alice -d alice_db -f /tmp/schema.sql

# Update after code change
docker compose build alice-adapter
docker compose up -d alice-adapter --force-recreate   # force-recreate re-reads env_file

# Check status
docker compose ps
docker compose logs -f alice-adapter
```

> **Note:** `docker compose restart` does NOT re-read `env_file`. Always use `--force-recreate` when changing `.env`.

---

## Test Environment: Mock P4 Relay + Node-RED + MQTT

For integration testing without real hardware, add these services to docker-compose:

```yaml
  mock-p4:
    image: node:20-alpine
    restart: unless-stopped
    working_dir: /app
    volumes:
      - /opt/mock-p4:/app
    command: node server.js
    networks: [alice-net]

  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    volumes:
      - /opt/mosquitto/config:/mosquitto/config
      - mosquitto-data:/mosquitto/data
    ports: ['1883:1883']

  nodered:
    image: nodered/node-red:latest
    restart: unless-stopped
    volumes:
      - /opt/nodered:/data
    ports: ['1880:1880']
    depends_on: [mosquitto]
```

**Mock P4 relay** implements the real P4 relay HTTP API:
```
GET  /internal/v1/houses/{house_id}/devices         → inventory
POST /internal/v1/houses/{house_id}/devices/state   → state query
POST /internal/v1/houses/{house_id}/devices/action  → action (updates mutable state)
```
Auth: `Authorization: Bearer {P4_RELAY_TOKEN}`

Set `P4_RELAY_URL=http://mock-p4:4000` in `.env`.

**Node-RED** (port 1880) provides:
- MQTT Monitor tab — live view of all `hi/#` MQTT events
- State-Change Tester tab — inject buttons to trigger P4 state-change webhooks to alice-adapter
- Alt P4 Relay tab — Node-RED as a drop-in P4 relay at port 1880

---

## Nginx Configuration

```nginx
server {
    listen 80;
    server_name alice.h-i.space;
    return 301 https://alice.h-i.space$request_uri;
}

server {
    listen 443 ssl;
    server_name alice.h-i.space;

    ssl_certificate     /etc/letsencrypt/live/alice.h-i.space/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.h-i.space/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # HI login stub (test/dev only)
    location /login-stub {
        proxy_pass       http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }

    # alice-adapter
    location / {
        proxy_pass             http://127.0.0.1:3000;
        proxy_http_version     1.1;
        proxy_set_header       Connection "";
        proxy_set_header       Host              $host;
        proxy_set_header       X-Real-IP         $remote_addr;
        proxy_set_header       X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header       X-Forwarded-Proto $scheme;
        proxy_read_timeout     15s;
        proxy_send_timeout     15s;
    }
}
```

TLS certificate via Let's Encrypt:
```bash
# Stop nginx, get cert, restart
systemctl stop nginx
certbot certonly --standalone -d alice.h-i.space --non-interactive --agree-tos --email you@example.com
systemctl start nginx
```

---

## Observability

### Key log events

| Message | Level | Meaning |
|---------|-------|---------|
| `Discovery response built` | INFO | `exposedDevices` = devices returned to Yandex |
| `P4 offline during discovery` | WARN | P4 board unreachable — returns empty list |
| `P4 relay: house not found` | WARN | house_id not registered in relay |
| `Token pair issued` | INFO | Account linked successfully |
| `Invalid or expired Bearer token` | WARN | Failed auth |
| `Yandex callback failed after all retries` | ERROR | State push not reaching Yandex |

### Metrics endpoint

```bash
curl https://alice.h-i.space/metrics   # Prometheus format
```

---

## Known Deployment Gotchas

| Symptom | Cause | Fix |
|---------|-------|-----|
| Yandex OAuth save button does nothing | HTTPS not reachable from Yandex | Obtain TLS cert first |
| `GET /v1.0/v1.0/user/devices` → 404 | Backend URL in Dialogs includes `/v1.0` | Remove the suffix |
| `POST /oauth/token` → 415 Unsupported Media Type | Fastify missing form-body parser | Fixed in `src/app.ts` — ensure you're running latest build |
| `POST /oauth/token` → 400 Auth code not found | Container running with stale `.env` (old placeholder values) | `docker compose up --force-recreate alice-adapter` |
| Login page loads but redirect goes to `127.0.0.1` | Login stub redirecting to internal address | Stub must redirect to `redirect_back` param (public URL), not hardcoded internal address |
| Discovery returns empty list | P4 relay URL paths wrong | Real P4 API is `/internal/v1/houses/{id}/devices` — not `/p4/inventory/{id}` |

---

## Pre-Production Checklist

- [ ] TLS certificate valid and CA-trusted (Let's Encrypt works)
- [ ] `SERVICE_BASE_URL` matches the URL registered in Yandex Dialogs exactly
- [ ] Backend URL in Yandex Dialogs is base domain **without** `/v1.0`
- [ ] `TOKEN_ENCRYPTION_KEY` and `TOKEN_HMAC_KEY` are 64 random hex chars each, different from each other
- [ ] `P4_RELAY_TOKEN` is a strong random secret (32+ bytes)
- [ ] DB schema applied: `CREATE TABLE IF NOT EXISTS` runs cleanly
- [ ] Health check responding: `curl https://alice.h-i.space/v1.0` → `200 OK`
- [ ] End-to-end account linking tested: authorize → login → token issued
- [ ] Discovery returns expected devices
- [ ] At least one action round-trip verified (status: DONE in Yandex logs)
- [ ] `YANDEX_SKILL_ID` and `YANDEX_SKILL_OAUTH_TOKEN` set for push notifications
