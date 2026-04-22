# A8 — Test Harness

## Test Structure

```
src/__tests__/
├── mappers/
│   ├── device.mapper.test.ts   — all 15 device kinds + filtering + ID format
│   ├── state.mapper.test.ts    — state mapping per kind + clamping + timestamps
│   └── action.mapper.test.ts   — capability actions + invalid values + relative
├── services/
│   └── token.service.test.ts   — generation + HMAC + AES-256-GCM encrypt/decrypt
└── controllers/
    └── routes.integration.test.ts — full HTTP tests via Fastify inject()
```

## Running Tests

```bash
npm test           # run all tests once
npm run test:cov   # with coverage report
npx vitest watch   # watch mode during development
```

## Test Categories

### Contract Tests (Yandex Spec Compliance)

Verify that responses exactly match the Yandex Smart Home REST spec:

- `GET /v1.0/user/devices` response has `request_id`, `payload.user_id`, `payload.devices[]`
- Each device has stable `id`, valid `type`, `capabilities[]`, `properties[]`
- `POST /v1.0/user/devices/query` returns per-device `capabilities`, `properties` or `error_code`
- `POST /v1.0/user/devices/action` returns per-device per-capability `action_result.status`
- `POST /v1.0/user/unlink` returns `{ request_id }`
- `GET /v1.0` and `HEAD /v1.0` return 200

### Negative Tests

| Scenario | Expected |
|----------|---------|
| Missing Authorization header | 401 `MISSING_CREDENTIALS` |
| Wrong scheme (Basic, Digest) | 401 `MISSING_CREDENTIALS` |
| Invalid Bearer token | 401 `INVALID_TOKEN` |
| Empty `devices[]` in query | 400 |
| Device ID wrong house | 200 + `DEVICE_NOT_FOUND` |
| P4 relay timeout on query | 200 + `DEVICE_UNREACHABLE` |
| P4 relay timeout on action | 200 + `DEVICE_UNREACHABLE` |
| P4 offline on discovery | 200 + empty list |
| Wrong relay token on webhook | 401 |
| Invalid webhook payload | 400 |
| Unknown route | 404 `NOT_FOUND` |
| Unsupported capability (toggle) | 200 + `NOT_SUPPORTED_IN_CURRENT_MODE` |
| AES tampered ciphertext | throws (GCM auth tag fails) |
| AES tampered auth tag | throws |

### Replay Scenarios (A8 Requirement)

Simulate Yandex retrying the same request (idempotency):

| Scenario | Behaviour |
|----------|-----------|
| Same `X-Request-Id` on `GET /devices` | Both return 200 with same device list |
| Same `X-Request-Id` on `POST /action` | Both return 200 DONE |
| Duplicate state-change webhook | Second enqueue skipped (dedup via Redis NX) |

### Observability Tests

| Test | Verifies |
|------|---------|
| `GET /metrics` returns 200 | Metrics endpoint available |
| Response body `Content-Type` is `text/plain` | Prometheus format |
| After a request, counter increments | `alice_http_requests_total` populated |
| `X-Request-Id` propagates to response body and header | Correlation chain |

## Mocking Strategy

### Infrastructure Mocks (per test app)

```typescript
// PostgreSQL — returns empty array for all queries
const pgFn = async () => [];
app.decorate('pg', Object.assign(pgFn, { unsafe: async () => [] }));

// Redis — all methods stubbed
app.decorate('redis', {
  get:   vi.fn().mockResolvedValue(null),
  set:   vi.fn().mockResolvedValue('OK'),    // dedup NX check
  setex: vi.fn().mockResolvedValue('OK'),    // token cache
  del:   vi.fn().mockResolvedValue(1),
  lpush: vi.fn().mockResolvedValue(1),       // notification queue
  brpop: vi.fn().mockResolvedValue(null),    // worker (non-blocking)
});
```

### Service Mocks (module-level)

```typescript
// P4 relay — return configurable responses per test
vi.mock('../../services/p4.service.js', () => ({
  fetchP4Inventory:   mocks.fetchP4Inventory,
  queryP4DeviceState: mocks.queryP4DeviceState,
  sendP4DeviceAction: mocks.sendP4DeviceAction,
  P4RelayError:       class P4RelayError extends Error { … },
}));

// Token validation — bypass DB/Redis in auth middleware
vi.mock('../../services/token.service.js', async (orig) => ({
  ...await orig(),
  validateBearerToken: mocks.validateBearerToken,
}));
```

### Environment Setup

All required env vars are set in `vitest.setup.ts` before any module loads:

```typescript
process.env['TOKEN_ENCRYPTION_KEY'] = 'a'.repeat(64);
process.env['TOKEN_HMAC_KEY']       = 'b'.repeat(64);
// … etc
```

## Coverage Targets

| Module | Target |
|--------|--------|
| `mappers/*` | 100% lines |
| `services/crypto.service` | 100% lines |
| `services/token.service` (pure functions) | 100% lines |
| `controllers/*` | ≥ 90% lines |
| `middleware/auth` | 100% branches |

## Adding New Tests

For a new device kind `my_device`:
1. Add to `device.mapper.test.ts` → verify type, capabilities, properties
2. Add to `state.mapper.test.ts` → verify each property key maps correctly
3. Add to `action.mapper.test.ts` if it has writable capabilities
4. Add a negative test: device with missing properties → capability omitted, not errored
