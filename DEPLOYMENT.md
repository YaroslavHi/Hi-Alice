# Deployment Guide — alice-adapter

## Prerequisites

| Component | Minimum version | Notes |
|-----------|----------------|-------|
| Node.js | 20 LTS | Runtime |
| PostgreSQL | 15 | Supabase or self-hosted |
| Redis | 7 | Token cache + future pub/sub |
| Docker | 24 | For containerised deploy |

---

## Yandex Developer Console Setup

Before deploying, you need two separate Yandex credential sets:

### 1. Smart Home Skill (OAuth server for account linking)

1. Go to [Yandex Dialogs](https://dialogs.yandex.ru/developer)
2. Create a new skill → **Smart Home**
3. In skill settings → **OAuth**:
   - Authorization endpoint: `https://alice.h-i.space/oauth/authorize`
   - Token endpoint: `https://alice.h-i.space/oauth/token`
   - Client ID → set as `YANDEX_CLIENT_ID`
   - Client Secret → set as `YANDEX_CLIENT_SECRET`
4. In skill settings → **Webhook**:
   - URL: `https://alice.h-i.space/v1.0`
5. Note your **Skill ID** → set as `YANDEX_SKILL_ID`
6. Generate a **skill OAuth token** from the console → set as `YANDEX_SKILL_OAUTH_TOKEN`
   (This is used for outbound state change notifications, not for account linking)

### Two distinct credential types

```
YANDEX_CLIENT_ID / YANDEX_CLIENT_SECRET  ← used by Yandex to call /oauth/token
                                            and by us to validate account linking

YANDEX_SKILL_ID / YANDEX_SKILL_OAUTH_TOKEN ← used by alice-adapter to push
                                              state changes TO Yandex
```

---

## Environment Setup

```bash
cp .env.example .env
```

Required values to fill in:

| Variable | Where to get it |
|----------|----------------|
| `DATABASE_URL` | Supabase → Settings → Database → Connection string |
| `REDIS_URL` | Your Redis instance URL |
| `YANDEX_CLIENT_ID` | Yandex Dialogs → skill OAuth settings |
| `YANDEX_CLIENT_SECRET` | Yandex Dialogs → skill OAuth settings |
| `HI_LOGIN_URL` | Your HI auth service login page URL |
| `SERVICE_BASE_URL` | Public HTTPS URL of this service (e.g. `https://alice.h-i.space`) |
| `TOKEN_PEPPER` | Run: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `P4_RELAY_URL` | Internal URL of your P4 relay service |
| `P4_RELAY_TOKEN` | Strong random secret shared with P4 relay |
| `YANDEX_SKILL_ID` | Yandex Dialogs → skill settings |
| `YANDEX_SKILL_OAUTH_TOKEN` | Yandex Dialogs → skill OAuth token |

---

## Database Migration

```bash
# First deploy only — idempotent (uses CREATE TABLE IF NOT EXISTS)
npm run migrate

# Or via Docker:
docker compose exec alice-adapter node scripts/migrate.js
```

---

## Docker Deployment

### Build and start

```bash
# Build image
docker compose build

# Start all services (PostgreSQL, Redis, alice-adapter)
docker compose up -d

# Run migrations
docker compose exec alice-adapter node scripts/migrate.js

# Check logs
docker compose logs -f alice-adapter
```

### Health check

```bash
curl -i https://alice.h-i.space/v1.0
# HTTP/1.1 200 OK
# {"status":"ok"}
```

---

## Nginx Configuration

The service runs on port 3000. Example Nginx upstream configuration:

```nginx
upstream alice_adapter {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name alice.h-i.space;

    ssl_certificate     /etc/letsencrypt/live/alice.h-i.space/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alice.h-i.space/privkey.pem;

    # Required: Yandex verifies TLS and rejects self-signed certs.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass         http://alice_adapter;
        proxy_http_version 1.1;
        proxy_set_header   Connection "";
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Yandex expects responses within 5s — set upstream timeout generously.
        proxy_read_timeout 15s;
        proxy_send_timeout 15s;
    }

    # Block internal webhook from external access.
    location /internal/ {
        allow 10.0.0.0/8;   # P4 relay subnet only
        allow 172.16.0.0/12;
        deny  all;
        proxy_pass http://alice_adapter;
    }
}
```

---

## Network Security

### Inbound (from Yandex)

Yandex Smart Home sends requests from these IP ranges (verify current list at Yandex docs):
- Standard Yandex datacenter IPs

Recommend: no IP allowlist on Yandex-facing endpoints — token validation handles auth.

### Internal webhook

`POST /internal/p4/state-change` must be reachable only from the P4 relay service:
- Restrict at Nginx level (see `location /internal/` above)
- Or use a separate internal port (e.g. `PORT_INTERNAL=3001`)
- The endpoint also validates `P4_RELAY_TOKEN` regardless

---

## Observability

### Structured logs (pino)

All logs are JSON in production:

```json
{
  "level": 30,
  "time": 1745229841000,
  "pid": 1,
  "msg": "Token validated",
  "tokenId": "atok-uuid",
  "userId": "user-001",
  "houseId": "sb-00A3F2",
  "requestId": "yandex-request-uuid"
}
```

Sensitive fields are redacted automatically:
- `req.headers.authorization` → `[REDACTED]`
- `body.client_secret` → `[REDACTED]`
- `body.code` → `[REDACTED]`
- `body.refresh_token` → `[REDACTED]`

### Key log events to monitor

| Event | Level | What it means |
|-------|-------|---------------|
| `Token validated` | DEBUG | Normal auth |
| `Invalid or expired Bearer token` | WARN | Failed auth (may be attack) |
| `P4 offline during discovery` | WARN | P4 board unreachable |
| `P4 relay timeout during discovery` | ERROR | Relay too slow |
| `P4 relay failed during state query` | ERROR | Query path down |
| `P4 relay error during action` | ERROR | Action path down |
| `Yandex callback failed after all retries` | ERROR | Notifications not reaching Yandex |
| `Token pair issued` | INFO | New account link |
| `Account unlinked` | INFO | User unlinked skill |

### Metrics to alert on

| Metric | Alert threshold |
|--------|----------------|
| 401 rate on `/v1.0/user/*` | > 10/min |
| P4 relay timeout rate | > 5% of requests |
| Yandex callback retry rate | > 20% of notifications |
| `oauth_access_tokens` rows with `revoked_at IS NULL` | Unexpected spike |

---

## Token Lifecycle Management

### Expired token cleanup (cron job)

Tokens expire but are not auto-deleted. Run a weekly cleanup:

```sql
-- Delete expired, revoked tokens older than 7 days
DELETE FROM oauth_refresh_tokens
WHERE expires_at < now() - INTERVAL '7 days';

DELETE FROM oauth_access_tokens
WHERE expires_at < now() - INTERVAL '7 days';

-- Clean up orphaned lookup entries
DELETE FROM oauth_token_lookup
WHERE access_token_id NOT IN (SELECT id FROM oauth_access_tokens);

-- Trim audit log older than 90 days
DELETE FROM alice_audit_log
WHERE created_at < now() - INTERVAL '90 days';
```

Add this as a PostgreSQL scheduled function or an external cron.

---

## Rollback

The service is stateless beyond PostgreSQL and Redis. To rollback:

1. Deploy previous Docker image tag
2. No migration rollback needed (schema uses `IF NOT EXISTS`)
3. Tokens issued by new version remain valid (DB stores hashes, not version-specific data)

---

## Checklist: Pre-Production

- [ ] TLS certificate valid and trusted (not self-signed — Yandex rejects it)
- [ ] `SERVICE_BASE_URL` matches the URL registered in Yandex Dialogs exactly
- [ ] `TOKEN_PEPPER` generated with `crypto.randomBytes(32)` — never reuse across environments
- [ ] `P4_RELAY_TOKEN` is a strong random secret (32+ bytes)
- [ ] `/internal/` routes blocked at Nginx from public internet
- [ ] PostgreSQL connection string uses a dedicated service user (not superuser)
- [ ] Redis password set if Redis is exposed beyond localhost
- [ ] `npm run migrate` executed against production DB
- [ ] Health check endpoint responding: `curl https://alice.h-i.space/v1.0`
- [ ] Yandex Dialogs → skill → test account linking flow end-to-end
- [ ] Confirm `alice_audit_log` is receiving `token_issued` entries after linking
