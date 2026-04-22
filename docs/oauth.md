# A2 — Account Linking (OAuth 2.0)

## Overview

Full OAuth 2.0 Authorization Code Grant flow for Yandex Smart Home.
Tokens are **encrypted at rest** (AES-256-GCM). Lookup uses HMAC-SHA256 (O(1), no decryption on hot path).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `HEAD` | `/v1.0` | Yandex health check |
| `GET`  | `/oauth/authorize` | Entry point — redirect user to HI login |
| `GET`  | `/oauth/callback` | HI auth callback — issue auth code → redirect to Yandex |
| `POST` | `/oauth/token` | Token exchange (auth_code / refresh_token) |
| `POST` | `/v1.0/user/unlink` | Revoke account link |

## Data Model

```sql
alice_account_links (
  id                       UUID PRIMARY KEY,
  hi_house_id              TEXT NOT NULL UNIQUE,     -- one link per house
  hi_owner_account_id      TEXT NOT NULL,
  yandex_user_id           TEXT NOT NULL,
  access_token_encrypted   TEXT NOT NULL,            -- AES-256-GCM ciphertext
  access_token_hmac        TEXT NOT NULL UNIQUE,     -- HMAC-SHA256 for lookup
  access_token_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_token_encrypted  TEXT NOT NULL,
  refresh_token_hmac       TEXT NOT NULL UNIQUE,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  link_status              TEXT DEFAULT 'active'     -- 'active' | 'unlinked'
  created_at, updated_at
)
```

## Token Security

```
encrypt(raw_token) → AES-256-GCM(raw, key=TOKEN_ENCRYPTION_KEY, iv=random(12B))
                   → base64(iv || authTag || ciphertext)
                   → stored in *_encrypted column

hmac(raw_token)    → HMAC-SHA256(raw, key=TOKEN_HMAC_KEY)
                   → 64-char hex
                   → stored in *_hmac column (indexed)
```

**Why both?**
- HMAC: fast indexed lookup — `WHERE access_token_hmac = $1` in one query
- AES: at-rest security — DB compromise alone is insufficient to use tokens

## OAuth Flow

```
Yandex                alice-adapter              HI Auth
  │                        │                        │
  │── GET /oauth/authorize ▶│                        │
  │   ?client_id=...        │                        │
  │   &redirect_uri=...     │                        │
  │   &state=xyz            │                        │
  │                         │─ 302 → HI login ──────▶│
  │                         │                        │
  │◀── user authenticates ──────────────────────────│
  │                         │◀── GET /oauth/callback  │
  │                         │    ?hi_user_id=...      │
  │                         │    &hi_house_id=...     │
  │                         │    &yandex_user_id=...  │
  │                         │    &yandex_state=xyz    │
  │                         │                        │
  │                         │─ HMAC(code) → DB       │
  │                         │─ encrypt(code) not needed (verify-only)
  │                         │                        │
  │◀── 302 redirect_uri?code=...&state=xyz ──────────│
  │                         │                        │
  │── POST /oauth/token ───▶│                        │
  │   grant_type=auth_code  │                        │
  │   code=...              │                        │
  │                         │─ consumeAuthCode()     │
  │                         │  HMAC(code) → DB lookup│
  │                         │─ issueTokenPair()      │
  │                         │  AES-encrypt tokens    │
  │                         │  HMAC tokens           │
  │                         │  UPSERT alice_account_links
  │◀── { access_token,      │                        │
  │      refresh_token,     │                        │
  │      expires_in }       │                        │
```

## Token Validation (per-request hot path)

```
Yandex request: Authorization: Bearer {raw_token}

  Step 1: compute HMAC(raw_token)
  Step 2: Redis GET alice:link:{hmac}  → hit → return cached context (~1ms)
  Step 3: DB SELECT WHERE access_token_hmac = $hmac AND link_status = 'active'
            → found → cache result → return context (~5ms)
  Step 4: null → 401 INVALID_TOKEN
```

No argon2 on the hot path. No decryption needed for validation.

## Security Properties

| Property | Implementation |
|----------|---------------|
| Tokens encrypted at rest | AES-256-GCM, key in env |
| No tokens in logs | pino `redact` covers all token fields |
| HMAC for fast lookup | HMAC-SHA256, deterministic, constant-time |
| One active link per house | `UNIQUE(hi_house_id)` + UPSERT |
| New link replaces old | `ON CONFLICT DO UPDATE` — atomic swap |
| Auth code replay prevention | `used_at IS NOT NULL` guard |
| redirect_uri validated | must match `*.yandex.ru` or `*.yandex.net` |
| GCM authentication tag | tampering detection on decrypt |
