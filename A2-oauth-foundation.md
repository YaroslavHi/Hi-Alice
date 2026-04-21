# Stage A2 — OAuth 2.0 Foundation

**Service:** `alice-adapter`  
**Stage:** A2 (Foundation)  
**Status:** ✅ Implemented  

---

## What This Stage Implements

Stage A2 establishes the complete foundation for the Yandex Smart Home adapter:

1. **Project scaffold** — TypeScript strict, Fastify 4, Zod validation, pino logging  
2. **PostgreSQL schema** — OAuth auth codes, access tokens, refresh tokens, account links, audit log  
3. **OAuth 2.0 Authorization Server** — full Yandex account linking flow  
4. **Bearer token validation middleware** — Redis L1 → DB L2 → argon2 L3 lookup chain  
5. **Health check endpoints** — `GET /v1.0` and `HEAD /v1.0` (Yandex requirement)  
6. **Account unlink** — `POST /v1.0/user/unlink`  
7. **Security hardening** — token redaction in logs, argon2id hashing, rate limiting, non-root Docker  

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  alice-adapter                       │
│                                                     │
│  ┌─────────────┐   ┌──────────────┐                │
│  │ OAuth       │   │ Yandex       │                │
│  │ Controller  │   │ Webhook      │                │
│  │             │   │ Controllers  │                │
│  │ /authorize  │   │ /v1.0/...    │                │
│  │ /callback   │   │              │                │
│  │ /token      │   │              │                │
│  └──────┬──────┘   └──────┬───────┘               │
│         │                 │                         │
│         ▼                 ▼                         │
│  ┌──────────────────────────────────┐              │
│  │       Token Service              │              │
│  │  generate / hash / verify /      │              │
│  │  revoke / cache-invalidate       │              │
│  └───────────────┬──────────────────┘              │
│                  │                                  │
│         ┌────────┴────────┐                        │
│         ▼                 ▼                         │
│  ┌──────────────┐  ┌──────────────┐                │
│  │  Redis       │  │  PostgreSQL  │                │
│  │  (L1 cache)  │  │  (source of  │                │
│  │              │  │   truth)     │                │
│  └──────────────┘  └──────────────┘                │
└─────────────────────────────────────────────────────┘
```

---

## OAuth 2.0 Account Linking Flow

```
Yandex App            alice-adapter           HI Auth             P4 (future)
    │                      │                     │                    │
    │── Link Account ──────▶│                    │                    │
    │   GET /oauth/authorize│                    │                    │
    │   ?response_type=code │                    │                    │
    │   &client_id=...      │                    │                    │
    │   &redirect_uri=...   │                    │                    │
    │   &state=xyz          │                    │                    │
    │                       │                    │                    │
    │                       │─ validate client ──▶                    │
    │                       │  redirect to HI    │                    │
    │◀─ 302 → HI Login ─────│  login with state  │                    │
    │                       │                    │                    │
    │── User authenticates ────────────────────▶│                    │
    │   (HI credentials)    │                    │                    │
    │                       │◀── GET /oauth/callback                  │
    │                       │    ?user_id=...    │                    │
    │                       │    &house_id=...   │                    │
    │                       │    &yandex_user_id │                    │
    │                       │    &yandex_state   │                    │
    │                       │                    │                    │
    │                       │─ generate auth_code (nanoid 32)         │
    │                       │─ hash with argon2id + pepper            │
    │                       │─ store in oauth_auth_codes              │
    │                       │                    │                    │
    │◀─ 302 → Yandex ───────│                    │                    │
    │   redirect_uri?code=  │                    │                    │
    │   &state=xyz          │                    │                    │
    │                       │                    │                    │
    │── POST /oauth/token ──▶│                   │                    │
    │   grant_type=         │                    │                    │
    │   authorization_code  │                    │                    │
    │   code=...            │                    │                    │
    │   client_secret=...   │                    │                    │
    │                       │                    │                    │
    │                       │─ find auth codes (recent, non-used)     │
    │                       │─ argon2 verify each candidate           │
    │                       │─ mark code as used                      │
    │                       │─ generate access_token (nanoid 64)      │
    │                       │─ generate refresh_token (nanoid 64)     │
    │                       │─ hash both with argon2id + pepper        │
    │                       │─ insert oauth_access_tokens             │
    │                       │─ insert oauth_token_lookup (prefix)     │
    │                       │─ insert oauth_refresh_tokens            │
    │                       │─ upsert alice_account_links             │
    │                       │─ write audit log                        │
    │                       │                    │                    │
    │◀─ { access_token,  ───│                    │                    │
    │     refresh_token,    │                    │                    │
    │     expires_in }      │                    │                    │
```

---

## Token Validation Flow (Per-Request)

```
Yandex Webhook          alice-adapter         Redis          PostgreSQL
    │                        │                  │                │
    │─ POST /v1.0/user/* ───▶│                  │                │
    │  Authorization:        │                  │                │
    │  Bearer {token}        │                  │                │
    │                        │                  │                │
    │                        │─ extract prefix  │                │
    │                        │  (first 16 chars)│                │
    │                        │                  │                │
    │                        │─ GET cache key ─▶│                │
    │                        │                  │                │
    │           cache HIT ───│◀─ ValidatedToken─│                │
    │           (fast path)  │  (~1ms)          │                │
    │                        │                  │                │
    │           cache MISS ──│◀─ nil ───────────│                │
    │           (cold path)  │                  │                │
    │                        │─ SELECT by prefix──────────────▶│
    │                        │                  │  JOIN lookup + │
    │                        │                  │  access_tokens │
    │                        │◀─ token row ─────────────────────│
    │                        │                  │                │
    │                        │─ argon2 verify(token, hash)       │
    │                        │  (~50-100ms)     │                │
    │                        │                  │                │
    │                        │─ SETEX cache ───▶│                │
    │                        │  (min(TTL, 5min))│                │
    │                        │                  │                │
    │                        │─ attach tokenContext to request   │
    │                        │                  │                │
    │◀─ 200 response ────────│                  │                │
```

---

## Token Refresh Flow

```
Yandex              alice-adapter           PostgreSQL
    │                    │                      │
    │─ POST /oauth/token ▶│                     │
    │  grant_type=        │                     │
    │  refresh_token      │                     │
    │  refresh_token=...  │                     │
    │  client_secret=...  │                     │
    │                     │                     │
    │                     │─ find recent non-used refresh tokens ▶│
    │                     │◀─ candidates ──────────────────────────│
    │                     │─ argon2 verify each                    │
    │                     │                     │                  │
    │                     │─ UPDATE refresh_token SET used_at=now()│
    │                     │─ UPDATE access_token  SET revoked_at   │
    │                     │─ INSERT new access_token + lookup      │
    │                     │─ INSERT new refresh_token              │
    │                     │─ UPDATE alice_account_links            │
    │                     │                     │                  │
    │◀─ { new tokens } ───│                     │                  │
```

---

## Unlink Flow

```
Yandex              alice-adapter           PostgreSQL           Redis
    │                    │                      │                   │
    │─ POST /v1.0/user/unlink                   │                   │
    │  Authorization: Bearer {token}            │                   │
    │                    │                      │                   │
    │                    │─ validateBearerToken (L1/L2/L3)          │
    │                    │─ UPDATE access_tokens SET revoked_at     │
    │                    │─ UPDATE alice_account_links              │
    │                    │  SET unlinked_at=now()                   │
    │                    │─ INSERT alice_audit_log                  │
    │                    │  (Redis cache expires naturally)         │
    │                    │                      │                   │
    │◀─ { request_id } ──│                      │                   │
    │   HTTP 200         │                      │                   │
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/v1.0` | None | Health check (Yandex ping) |
| `HEAD` | `/v1.0` | None | Health check (Yandex ping) |
| `GET`  | `/oauth/authorize` | None | OAuth 2.0 authorization entry point |
| `GET`  | `/oauth/callback` | None | HI auth callback (issues auth code) |
| `POST` | `/oauth/token` | client_id+secret | Token exchange / refresh |
| `POST` | `/v1.0/user/unlink` | Bearer | Revoke account link |

---

## Database Schema

```sql
oauth_auth_codes       -- short-lived codes, single-use, hashed
oauth_access_tokens    -- long-lived, hashed, revocable
oauth_refresh_tokens   -- rotated on each refresh, hashed
oauth_token_lookup     -- prefix → token_id index for fast lookup
alice_account_links    -- user+house → yandex binding
alice_audit_log        -- append-only security audit
```

---

## Security Properties

| Property | Implementation |
|----------|---------------|
| Tokens never stored in plain text | argon2id + pepper |
| Tokens never appear in logs | pino `redact` config |
| No timing attacks on token lookup | argon2 verify always runs full hash |
| Token replay prevention | auth codes: `used_at` flag; refresh tokens: rotation |
| Token revocation | `revoked_at` on access token; cascade on refresh |
| Client secret validation | constant-time both-branch comparison |
| Open redirect prevention | `redirect_uri` validated against `yandex.ru / yandex.net` |
| Rate limiting | 100 req/min per IP via `@fastify/rate-limit` |
| Non-root container | `adduser alice` in Dockerfile |

---

## Known Risks

1. **Candidate scan for auth code verification** — fetches recent non-used codes and argon2-verifies each candidate. Acceptable at current scale (one household per linking session). At scale, add a short-lived nonce column with a B-tree index.

2. **Redis failure degrades to DB-only** — token validation still works but at ~50-100ms vs ~1ms. Monitor Redis availability separately.

3. **HI login → callback trust** — the callback endpoint trusts `user_id`, `house_id`, `yandex_user_id` from the HI auth system. These must be validated by HI auth before being passed here (not user-supplied). In production, use a signed short-lived JWT from HI auth instead of plain query params.

4. **Redirect URI storage via query param** — `yandex_redirect_uri` is passed through HI login as a query param. A signed session cookie is more robust but requires cookie infrastructure. Mitigated by strict hostname validation on callback.
