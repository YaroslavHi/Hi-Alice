# Deployment Guide

## Overview

The HI Alice Adapter stack consists of three components:

```
alice-adapter   — Fastify app, Yandex Smart Home API
postgres        — OAuth token store
redis           — Token L1 cache + notification queue
nodered         — P4 relay bridge: HTTP ↔ MQTT (optional, see §4)
```

The adapter is stateless beyond the database. Every deployment is a `docker compose up -d` with a populated `.env`.

---

## 1. Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Docker | 24+ | Docker Compose plugin included |
| Public HTTPS domain | — | Yandex requires TLS; self-signed not accepted |
| Yandex Developer Console account | — | dialogs.yandex.ru |

No Node.js or npm on the host is needed — everything runs inside Docker.

---

## 2. Yandex Developer Console — Skill Setup

### 2.1 Register a Smart Home skill

1. Go to [dialogs.yandex.ru](https://dialogs.yandex.ru/developer)
2. Create new skill → **Smart Home**
3. Set **Endpoint URL**: `https://alice.your-domain.com/v1.0`
4. Under **OAuth** → set authorization endpoint:
   `https://alice.your-domain.com/oauth/authorize`
5. Token endpoint: `https://alice.your-domain.com/oauth/token`
6. Copy **Client ID** and **Client Secret** → `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`

### 2.2 Get the Skill ID

After saving the skill, the URL contains the skill ID:
```
https://dialogs.yandex.ru/developer/skills/da1d45da-xxxx-xxxx-xxxx-xxxxxxxxxxxx/edit
```
Copy this UUID → `YANDEX_SKILL_ID` in `.env`.

### 2.3 Push notification token (after publication)

Available only after publishing as a private skill:
- Dialogs → skill → **Notifications** tab → copy OAuth token → `YANDEX_SKILL_OAUTH_TOKEN`

While the skill is in draft, Yandex polls for state every ~10 seconds. Push notifications reduce this to instant delivery.

---

## 3. Alice Adapter Deployment

### 3.1 Clone and prepare

```bash
git clone https://github.com/YaroslavHi/Hi-Alice.git
cd Hi-Alice
cp .env.example .env
```

### 3.2 Generate security keys

Run this **once** per deployment, save all output in `.env`:

```bash
node scripts/generate-keys.js
```

Or manually with Node.js:

```bash
node -e "
  const c = require('crypto');
  console.log('TOKEN_ENCRYPTION_KEY=' + c.randomBytes(32).toString('hex'));
  console.log('TOKEN_HMAC_KEY='       + c.randomBytes(32).toString('hex'));
  console.log('POSTGRES_PASSWORD='    + c.randomBytes(16).toString('hex'));
  console.log('P4_RELAY_TOKEN='       + c.randomBytes(24).toString('hex'));
"
```

### 3.3 Fill in `.env`

```env
DATABASE_URL=postgresql://alice_svc:YOUR_POSTGRES_PASSWORD@postgres:5432/hi_cloud
REDIS_URL=redis://redis:6379

YANDEX_CLIENT_ID=your-client-id
YANDEX_CLIENT_SECRET=your-client-secret
YANDEX_SKILL_ID=da1d45da-xxxx-xxxx-xxxx-xxxxxxxxxxxx
YANDEX_SKILL_OAUTH_TOKEN=           # leave empty until skill is published

HI_LOGIN_URL=https://alice.your-domain.com/login-stub
SERVICE_BASE_URL=https://alice.your-domain.com

TOKEN_ENCRYPTION_KEY=<64 hex chars>
TOKEN_HMAC_KEY=<64 hex chars>       # must differ from ENCRYPTION_KEY

P4_RELAY_URL=http://nodered:1880    # or http://your-relay:port
P4_RELAY_TOKEN=<random 32+ chars>

POSTGRES_PASSWORD=<same as in DATABASE_URL>
```

### 3.4 Start the stack

```bash
# Base stack (adapter + postgres + redis):
docker compose up -d

# Apply database schema (first deploy only):
docker compose exec alice-adapter node scripts/migrate.js

# With Node-RED relay (see §4):
docker compose -f docker-compose.yml -f docker-compose.nodered.yml up -d
```

### 3.5 Verify

```bash
curl https://alice.your-domain.com/v1.0
# → {"status":"ok"}

curl https://alice.your-domain.com/metrics | grep alice_http_requests_total
```

---

## 4. Node-RED P4 Relay

Node-RED bridges the alice-adapter's HTTP API and the real SmartBox controller over MQTT.

```
alice-adapter
    │ HTTP  P4_RELAY_URL=http://nodered:1880
    ▼
Node-RED  (/internal/v1/houses/:house_id/...)
    │ MQTT TLS  mqtts://your-broker:8883
    ▼
HI SmartBox Controller
  Read:  demo/v1/server/devices/{device_id}/{field}   (State, TemperatureValue, HumidityValue, ...)
  Write: demo/v1/client/devices/{device_id}/State     (True | False)
```

### 4.1 Configure MQTT broker

Edit `nodered/flows.json` — find nodes `mqtt-broker-1` and `mqtt-broker-real`:

```json
{
  "id": "mqtt-broker-real",
  "type": "mqtt-broker",
  "broker": "your-broker-hostname",
  "port": "8883",
  "usetls": true,
  "tls": "tls-mymqtt"
}
```

For self-signed certificates, the TLS config node has `"verifyservercert": false`.

### 4.2 Configure device inventory

Edit `fn-inventory` in `nodered/flows.json` — add your devices:

```javascript
devices: [
  {
    logical_device_id: 'switch_903858',   // ID as seen in MQTT topic
    kind: 'relay',
    semantics: 'light',
    name: 'Офисный свет',
    room: 'Офис',
    online: true,
    board_id: 'controller-01'
  },
  {
    logical_device_id: 'ds18b20_155881',
    kind: 'ds18b20',
    name: 'Температура',
    room: 'Офис',
    online: true,
    board_id: 'controller-01'
  }
  // Add all devices here — see docs/mapping.md for supported kind values
]
```

Also update the `KIND` lookup table in `fn-state`:
```javascript
const KIND = {
  'switch_903858':    'relay',
  'ds18b20_155881':   'ds18b20',
  // ...
};
```

### 4.3 Generate Node-RED credential secret

```bash
node -e "console.log('NODE_RED_CREDENTIAL_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

Add to `.env`. This encrypts the MQTT broker username/password at rest.

### 4.4 Set MQTT broker credentials

After first start, open Node-RED editor at `http://your-server:1880`:
1. Double-click an MQTT broker node
2. Click the pencil icon
3. Enter **Username** and **Password** for your MQTT broker
4. Click **Update** → **Deploy**

Node-RED stores credentials encrypted using `NODE_RED_CREDENTIAL_SECRET`.

### 4.5 Deploy

```bash
docker compose -f docker-compose.yml -f docker-compose.nodered.yml up -d

# Verify MQTT connected:
docker compose logs nodered | grep "Connected to broker"
# → [mqtt-broker:...] Connected to broker: ...@mqtts://your-broker:8883
```

### 4.6 Discover device IDs from MQTT traffic

Open Node-RED editor → **MQTT Monitor** tab → watch incoming messages.
All topics follow `demo/v1/server/devices/{device_id}/{field}`.

Or inspect the state cache directly:
```bash
curl http://localhost:1880/context/flow/tab-p4relay
# → {"memory":{"mqttState":{"switch_903858":{"on":false},"ds18b20_155881":{"temperature":25.5}}}}
```

### 4.7 Verify P4 relay

```bash
# Get inventory:
curl http://localhost:1880/internal/v1/houses/YOUR_HOUSE_ID/devices \
  -H "Authorization: Bearer YOUR_P4_RELAY_TOKEN"

# Get device state:
curl -X POST http://localhost:1880/internal/v1/houses/YOUR_HOUSE_ID/devices/state \
  -H "Authorization: Bearer YOUR_P4_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_ids":["switch_903858"]}'

# Send action:
curl -X POST http://localhost:1880/internal/v1/houses/YOUR_HOUSE_ID/devices/action \
  -H "Authorization: Bearer YOUR_P4_RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"switch_903858","property":"on","value":true}'
```

---

## 5. Reverse Proxy (nginx + Let's Encrypt)

Yandex requires a valid HTTPS certificate.

```nginx
server {
    listen 443 ssl;
    server_name alice.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/alice.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

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

**Important:** Do NOT expose port 1880 (Node-RED editor) publicly in production.

---

## 6. Login Stub (testing without real HI auth)

The login stub accepts any credentials and issues an OAuth code — for development only.

Save as `/opt/login-stub/server.js`:

```javascript
const http = require('http');
const url  = require('url');
const crypto = require('crypto');

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h2>HI Login (test stub)</h2>
      <form method="POST" action="/login-stub${req.url.replace('/login-stub', '')}">
        <p><input name="house_id" placeholder="House ID (e.g. sb-TEST01)" required></p>
        <p><input name="yandex_uid" placeholder="Yandex UID" required></p>
        <p><button type="submit">Login</button></p>
      </form></body></html>`);
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const params   = new URLSearchParams(body);
      const redirect = parsed.query.redirect_uri || '';
      const state    = parsed.query.state || '';
      const code     = crypto.randomBytes(16).toString('hex');
      const location = `${redirect}?code=${code}&state=${state}` +
                       `&house_id=${encodeURIComponent(params.get('house_id'))}` +
                       `&yandex_uid=${encodeURIComponent(params.get('yandex_uid'))}`;
      res.writeHead(302, { Location: location });
      res.end();
    });
    return;
  }

  res.writeHead(404); res.end();
}).listen(3001, () => console.log('Login stub listening on :3001'));
```

Add to nginx:
```nginx
location /login-stub {
    proxy_pass http://127.0.0.1:3001;
}
```

---

## 7. Account Linking

After deploying:

1. Open **Яндекс** app → Устройства → Добавить → Умный дом → HI SmartBox
2. Log in with your house credentials (or stub: enter house ID + Yandex UID)
3. Alice discovers all devices from the P4 relay inventory
4. Done — Alice shows all devices, state queries and commands work

To re-trigger discovery after adding new devices:
- Яндекс app → skill settings → **Обновить список устройств**

---

## 8. Updates

```bash
cd Hi-Alice
git pull

# Rebuild and redeploy:
docker compose build alice-adapter
docker compose exec alice-adapter node scripts/migrate.js
docker compose up -d alice-adapter --force-recreate
```

Node-RED flows update:
```bash
# Edit nodered/flows.json locally, then copy to server:
scp nodered/flows.json user@server:/opt/nodered/flows.json
docker compose restart nodered
```

---

## 9. Observability

### Logs

```bash
docker compose logs -f alice-adapter
docker compose logs -f nodered
```

Key log messages:

| Message | Meaning |
|---------|---------|
| `Discovery response built` | Yandex requested device list |
| `State query completed` | Yandex polled device states |
| `Action request completed` | Yandex sent a command |
| `P4 relay failed during inventory fetch` | Cannot reach Node-RED relay |
| `Device in query has no v1 semantic profile` | kind+semantics not in allowlist |

### Metrics

```bash
curl http://localhost:3000/metrics
```

| Metric | Description |
|--------|-------------|
| `alice_http_requests_total` | Requests by route/method/status |
| `alice_http_duration_ms` | Response time histogram |
| `alice_p4_requests_total` | P4 relay call count |
| `alice_notifications_total` | Yandex push callback count |

---

## 10. Pre-production Checklist

- [ ] `TOKEN_ENCRYPTION_KEY` is a unique random 64-hex string
- [ ] `TOKEN_HMAC_KEY` is a unique random 64-hex string, different from `TOKEN_ENCRYPTION_KEY`
- [ ] `POSTGRES_PASSWORD` is a strong random password
- [ ] `P4_RELAY_TOKEN` is a strong random secret (min 32 chars)
- [ ] HTTPS certificate is valid (not self-signed)
- [ ] `SERVICE_BASE_URL` matches the domain in Yandex Developer Console exactly
- [ ] `YANDEX_REDIRECT_URI_ALLOWLIST` matches the redirect URI in Yandex Console
- [ ] Port 3000 is NOT exposed publicly (only nginx proxies to it)
- [ ] Port 1880 (Node-RED) is NOT exposed publicly
- [ ] Database schema applied (`node scripts/migrate.js`)
- [ ] Health endpoint returns 200 (`curl https://alice.your-domain.com/v1.0`)
- [ ] At least one device appears after account linking

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Yandex shows "навык недоступен" | `/v1.0` not returning 200 | `docker compose logs alice-adapter` |
| OAuth redirect fails | `SERVICE_BASE_URL` mismatch | Check `.env` vs Yandex Console |
| No devices in discovery | P4 relay unreachable | `curl http://nodered:1880/internal/...` |
| Device shows "недоступно" | `online: false` from relay | Check MQTT broker connection in Node-RED logs |
| Actions time out | P4 relay slow or down | Increase `P4_RELAY_TIMEOUT_MS` |
| "Failed to decrypt credentials" (Node-RED) | Auto-key conflict with user key | Delete `_credentialSecret` from `/data/.config.runtime.json` in Node-RED volume, restart |
| MQTT not connecting | Wrong broker host/port/credentials | Open Node-RED editor, update broker node credentials |
| `TOKEN_PEPPER` error at startup | Old env var name | Replace with `TOKEN_ENCRYPTION_KEY` + `TOKEN_HMAC_KEY` |
