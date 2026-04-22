/**
 * @file controllers/routes.integration.test.ts
 *
 * Full HTTP integration tests using Fastify inject().
 * Infrastructure (DB, Redis, P4 relay) is mocked via vi.hoisted + vi.mock.
 * Tests cover: auth middleware, all Yandex webhook endpoints,
 * internal webhooks, 404 handler, metrics endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  fetchP4Inventory:    vi.fn(),
  queryP4DeviceState:  vi.fn(),
  sendP4DeviceAction:  vi.fn(),
  validateBearerToken: vi.fn(),
  listDevices:         vi.fn(),
}));

vi.mock('../services/p4.service.js', () => ({
  fetchP4Inventory:   mocks.fetchP4Inventory,
  queryP4DeviceState: mocks.queryP4DeviceState,
  sendP4DeviceAction: mocks.sendP4DeviceAction,
  P4RelayError: class P4RelayError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'P4RelayError';
      this.code = code;
    }
  },
}));

vi.mock('../services/token.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/token.service.js')>();
  return { ...original, validateBearerToken: mocks.validateBearerToken };
});

vi.mock('../services/house.service.js', () => ({
  listDevices: mocks.listDevices,
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_TOKEN = {
  access_token_id: 'link-uuid-001',
  user_id:         'hi-user-001',
  house_id:        'sb-00A3F2',
  yandex_user_id:  'yandex-uid-123',
  scope:           '',
  expires_at:      new Date(Date.now() + 86_400_000),
};

const RELAY_TOKEN = 'relay-token-longer-than-16-chars';

// ─── Test app factory ─────────────────────────────────────────────────────────

/**
 * Build a self-contained Fastify app for testing.
 * Decorates pg and redis directly — no real DB/Redis connections.
 * The Redis mock includes all methods used across the codebase:
 *   get, setex, del, set (NX), lpush, brpop (notification queue)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // ── PG mock — tagged template literal returning empty array ───────────────
  const pgFn = async (..._args: unknown[]): Promise<unknown[]> => [];
  app.decorate('pg', Object.assign(pgFn, { unsafe: async () => [] }) as any);

  // ── Redis mock — covers all methods used in the codebase ──────────────────
  app.decorate('redis', {
    get:    vi.fn().mockResolvedValue(null),
    set:    vi.fn().mockResolvedValue('OK'),   // used by dedup in notification.service
    setex:  vi.fn().mockResolvedValue('OK'),   // used by token cache
    del:    vi.fn().mockResolvedValue(1),
    lpush:  vi.fn().mockResolvedValue(1),      // used by notification queue
    brpop:  vi.fn().mockResolvedValue(null),   // notification worker (blocks)
  } as any);

  const { default: requestIdPlugin } = await import('../plugins/request-id.js');
  const { default: metricsPlugin }   = await import('../plugins/metrics.js');
  await app.register(requestIdPlugin);
  await app.register(metricsPlugin);

  const { registerRoutes } = await import('../routes/index.js');
  await registerRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      request_id: (request as any).requestId ?? '',
      status:     'ERROR',
      error_code: 'NOT_FOUND',
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = (request as any).requestId ?? '';
    if (error.validation) {
      return reply.code(400).send({ request_id: requestId, status: 'ERROR', error_code: 'VALIDATION_ERROR' });
    }
    return reply.code(500).send({ request_id: requestId, status: 'ERROR', error_code: 'INTERNAL_ERROR' });
  });

  await app.ready();
  return app;
}

// ─── Health ───────────────────────────────────────────────────────────────────

describe('Health endpoints', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async () => { await app.close(); });

  it('GET /v1.0 → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1.0' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('HEAD /v1.0 → 200', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/v1.0' });
    expect(res.statusCode).toBe(200);
  });

  it('echoes X-Request-Id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1.0', headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

describe('GET /metrics (A7)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 200 with Prometheus text format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('increments request counter after requests', async () => {
    await app.inject({ method: 'GET', url: '/v1.0' });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.payload).toContain('alice_http_requests_total');
  });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(null);
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('401 — missing Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1.0/user/devices' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('MISSING_CREDENTIALS');
  });

  it('401 — non-Bearer scheme', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1.0/user/devices',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('MISSING_CREDENTIALS');
  });

  it('401 — token validation returns null', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1.0/user/devices',
      headers: { authorization: 'Bearer invalid' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('INVALID_TOKEN');
  });

  it('request_id echoed in 401 body', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1.0/user/devices',
      headers: { 'x-request-id': 'req-id-abc' },
    });
    expect(res.json().request_id).toBe('req-id-abc');
  });
});

// ─── Discovery (A3) ───────────────────────────────────────────────────────────

const now = new Date();
const DB_DEVICES = [
  { houseId: 'sb-00A3F2', logicalDeviceId: 'relay-01',  kind: 'relay',           semantics: 'light', name: 'Ceiling Light', room: 'Living Room', boardId: 'b1', meta: null, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now },
  { houseId: 'sb-00A3F2', logicalDeviceId: 'dimmer-01', kind: 'dimmer',           semantics: null,    name: 'Bedroom',       room: 'Bedroom',     boardId: 'b1', meta: null, enabled: true, sortOrder: 1, createdAt: now, updatedAt: now },
  { houseId: 'sb-00A3F2', logicalDeviceId: 'ds-01',     kind: 'ds18b20',          semantics: null,    name: 'Temp Sensor',   room: 'Kitchen',     boardId: 'b1', meta: null, enabled: true, sortOrder: 2, createdAt: now, updatedAt: now },
  { houseId: 'sb-00A3F2', logicalDeviceId: 'future-01', kind: 'unknown_future',   semantics: null,    name: 'X',             room: 'Hall',        boardId: 'b1', meta: null, enabled: true, sortOrder: 3, createdAt: now, updatedAt: now },
];

describe('GET /v1.0/user/devices (A3)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(VALID_TOKEN);
    mocks.listDevices.mockResolvedValue(DB_DEVICES);
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('200 with mapped devices — unsupported kinds filtered', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1.0/user/devices',
      headers: { authorization: 'Bearer t', 'x-request-id': 'disc-001' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.request_id).toBe('disc-001');
    expect(body.payload.user_id).toBe('yandex-uid-123');
    // 3 supported, 1 filtered (unknown_future kind has no v1 profile)
    expect(body.payload.devices).toHaveLength(3);
    expect(body.payload.devices[0].id).toBe('hi:sb-00A3F2:relay-01');
    expect(body.payload.devices[0].type).toBe('devices.types.light');
    expect(body.payload.devices[2].type).toBe('devices.types.sensor.climate');
  });

  it('device IDs are stable: hi:{house}:{logical_device_id}', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1.0/user/devices',
      headers: { authorization: 'Bearer t' },
    });
    const ids = res.json().payload.devices.map((d: any) => d.id);
    expect(ids[0]).toBe('hi:sb-00A3F2:relay-01');
    expect(ids[1]).toBe('hi:sb-00A3F2:dimmer-01');
  });

  it('200 empty list when DB unavailable', async () => {
    mocks.listDevices.mockRejectedValue(new Error('DB connection failed'));
    const res = await app.inject({ method: 'GET', url: '/v1.0/user/devices', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().payload.devices).toHaveLength(0);
  });

  it('200 empty list when house has no devices', async () => {
    mocks.listDevices.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/v1.0/user/devices', headers: { authorization: 'Bearer t' } });
    expect(res.json().payload.devices).toHaveLength(0);
  });

  it('custom_data includes house_id and logical_device_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1.0/user/devices', headers: { authorization: 'Bearer t' } });
    const d = res.json().payload.devices[0];
    expect(d.custom_data.house_id).toBe('sb-00A3F2');
    expect(d.custom_data.logical_device_id).toBe('relay-01');
  });
});

// ─── State query (A4) ─────────────────────────────────────────────────────────

describe('POST /v1.0/user/devices/query (A4)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(VALID_TOKEN);
    mocks.listDevices.mockResolvedValue([
      { houseId: 'sb-00A3F2', logicalDeviceId: 'relay-01', kind: 'relay', semantics: 'light', name: 'Ceiling Light', room: 'Living Room', boardId: 'b1', meta: null, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now },
    ]);
    mocks.queryP4DeviceState.mockResolvedValue({
      house_id: 'sb-00A3F2', fetched_at: new Date().toISOString(),
      devices: [{
        logical_device_id: 'relay-01', online: true,
        properties: [{ key: 'on', value: true, updated_at: '2026-04-21T10:00:00Z' }],
      }],
    });
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1.0/user/devices/query', payload: { devices: [{ id: 'x' }] } });
    expect(res.statusCode).toBe(401);
  });

  it('400 for empty devices array', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/query',
      headers: { authorization: 'Bearer t' },
      payload: { devices: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 with on_off state for relay', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/query',
      headers: { authorization: 'Bearer t', 'x-request-id': 'q-001' },
      payload: { devices: [{ id: 'hi:sb-00A3F2:relay-01', custom_data: { kind: 'relay' } }] },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().payload.devices[0];
    expect(d.id).toBe('hi:sb-00A3F2:relay-01');
    expect(d.capabilities[0].type).toBe('devices.capabilities.on_off');
    expect((d.capabilities[0].state as any).value).toBe(true);
  });

  it('DEVICE_NOT_FOUND for wrong house_id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/query',
      headers: { authorization: 'Bearer t' },
      payload: { devices: [{ id: 'hi:WRONG-HOUSE:relay-01', custom_data: { kind: 'relay' } }] },
    });
    expect(res.json().payload.devices[0].error_code).toBe('DEVICE_NOT_FOUND');
  });

  it('DEVICE_UNREACHABLE when P4 relay times out', async () => {
    const { P4RelayError } = await import('../services/p4.service.js');
    mocks.queryP4DeviceState.mockRejectedValue(new P4RelayError('timeout', 'timed out'));
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/query',
      headers: { authorization: 'Bearer t' },
      payload: { devices: [{ id: 'hi:sb-00A3F2:relay-01', custom_data: { kind: 'relay' } }] },
    });
    expect(res.json().payload.devices[0].error_code).toBe('DEVICE_UNREACHABLE');
  });

  it('DEVICE_UNREACHABLE when device is offline in P4 state', async () => {
    mocks.queryP4DeviceState.mockResolvedValue({
      house_id: 'sb-00A3F2', fetched_at: new Date().toISOString(),
      devices: [{ logical_device_id: 'relay-01', online: false, properties: [] }],
    });
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/query',
      headers: { authorization: 'Bearer t' },
      payload: { devices: [{ id: 'hi:sb-00A3F2:relay-01', custom_data: { kind: 'relay' } }] },
    });
    expect(res.json().payload.devices[0].error_code).toBe('DEVICE_UNREACHABLE');
  });

  it('always returns HTTP 200 even for device errors', async () => {
    // Yandex spec: per-device errors go in error_code, not HTTP status.
    const { P4RelayError } = await import('../services/p4.service.js');
    mocks.queryP4DeviceState.mockRejectedValue(new P4RelayError('house_offline', 'offline'));
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/query',
      headers: { authorization: 'Bearer t' },
      payload: { devices: [{ id: 'hi:sb-00A3F2:relay-01', custom_data: { kind: 'relay' } }] },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Device action (A4) ───────────────────────────────────────────────────────

describe('POST /v1.0/user/devices/action (A4)', () => {
  let app: FastifyInstance;

  const ON_OFF_REQUEST = {
    payload: { devices: [{
      id: 'hi:sb-00A3F2:relay-01',
      capabilities: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }],
    }]},
  };

  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(VALID_TOKEN);
    mocks.listDevices.mockResolvedValue([
      { houseId: 'sb-00A3F2', logicalDeviceId: 'relay-01',  kind: 'relay',  semantics: 'light', name: 'Ceiling Light', room: 'Living Room', boardId: 'b1', meta: null, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now },
      { houseId: 'sb-00A3F2', logicalDeviceId: 'relay-02',  kind: 'relay',  semantics: 'light', name: 'Socket',        room: 'Kitchen',     boardId: 'b1', meta: null, enabled: true, sortOrder: 1, createdAt: now, updatedAt: now },
      { houseId: 'sb-00A3F2', logicalDeviceId: 'dimmer-01', kind: 'dimmer', semantics: null,    name: 'Bedroom',       room: 'Bedroom',     boardId: 'b1', meta: null, enabled: true, sortOrder: 2, createdAt: now, updatedAt: now },
    ]);
    mocks.sendP4DeviceAction.mockResolvedValue({ request_id: 'r', house_id: 'h', device_id: 'd', status: 'ok' });
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('200 DONE — P4 owner-confirmed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/action',
      headers: { authorization: 'Bearer t', 'x-request-id': 'act-001' },
      payload: ON_OFF_REQUEST,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().payload.devices[0].capabilities[0].state.action_result.status).toBe('DONE');
    expect(res.json().request_id).toBe('act-001');
  });

  it('200 ERROR DEVICE_NOT_FOUND when P4 says device_not_found', async () => {
    mocks.sendP4DeviceAction.mockResolvedValue({ status: 'device_not_found', request_id: 'r', house_id: 'h', device_id: 'd' });
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/action',
      headers: { authorization: 'Bearer t' },
      payload: ON_OFF_REQUEST,
    });
    const ar = res.json().payload.devices[0].capabilities[0].state.action_result;
    expect(ar.status).toBe('ERROR');
    expect(ar.error_code).toBe('DEVICE_NOT_FOUND');
  });

  it('200 ERROR DEVICE_UNREACHABLE on relay timeout', async () => {
    const { P4RelayError } = await import('../services/p4.service.js');
    mocks.sendP4DeviceAction.mockRejectedValue(new P4RelayError('timeout', 'timed out'));
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/action',
      headers: { authorization: 'Bearer t' },
      payload: ON_OFF_REQUEST,
    });
    expect(res.json().payload.devices[0].capabilities[0].state.action_result.error_code).toBe('DEVICE_UNREACHABLE');
  });

  it('executes capabilities sequentially within a device', async () => {
    const callOrder: string[] = [];
    mocks.sendP4DeviceAction.mockImplementation(async (intent: any) => {
      callOrder.push(intent.property);
      return { status: 'ok', request_id: 'r', house_id: 'h', device_id: 'd' };
    });

    await app.inject({
      method: 'POST', url: '/v1.0/user/devices/action',
      headers: { authorization: 'Bearer t' },
      payload: { payload: { devices: [{
        id: 'hi:sb-00A3F2:dimmer-01',
        capabilities: [
          { type: 'devices.capabilities.on_off',   state: { instance: 'on',         value: true } },
          { type: 'devices.capabilities.range',     state: { instance: 'brightness', value: 80  } },
        ],
      }]}},
    });

    expect(callOrder).toEqual(['on', 'brightness']);
  });

  it('processes multiple devices in parallel', async () => {
    mocks.sendP4DeviceAction.mockResolvedValue({ status: 'ok', request_id: 'r', house_id: 'h', device_id: 'd' });

    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/action',
      headers: { authorization: 'Bearer t' },
      payload: { payload: { devices: [
        { id: 'hi:sb-00A3F2:relay-01', capabilities: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true  } }] },
        { id: 'hi:sb-00A3F2:relay-02', capabilities: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: false } }] },
      ]}},
    });

    expect(res.json().payload.devices).toHaveLength(2);
    expect(mocks.sendP4DeviceAction).toHaveBeenCalledTimes(2);
  });

  it('invalid action mapping returns 200 ERROR INVALID_ACTION', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/devices/action',
      headers: { authorization: 'Bearer t' },
      payload: { payload: { devices: [{
        id: 'hi:sb-00A3F2:relay-01',
        capabilities: [{ type: 'devices.capabilities.toggle', state: { instance: 'mute', value: true } }],
      }]}},
    });
    // toggle is unsupported → error, but HTTP 200
    expect(res.statusCode).toBe(200);
    expect(res.json().payload.devices[0].capabilities[0].state.action_result.status).toBe('ERROR');
  });
});

// ─── Internal webhooks (A5) ───────────────────────────────────────────────────

describe('POST /internal/p4/state-change (A5)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('401 — wrong relay token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/p4/state-change',
      payload: { house_id: 'h', yandex_user_id: 'y', logical_device_id: 'd', kind: 'relay', online: true, properties: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('202 — valid payload enqueued to Redis', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/p4/state-change',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        house_id: 'sb-00A3F2', yandex_user_id: 'y', logical_device_id: 'relay-01',
        kind: 'relay', online: true,
        properties: [{ key: 'on', value: true, updated_at: '2026-04-21T10:00:00Z' }],
      },
    });
    expect(res.statusCode).toBe(202);
    // Verify Redis lpush was called (notification queued)
    const redis = (app as any).redis;
    expect(redis.lpush).toHaveBeenCalled();
  });

  it('400 — invalid schema', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/p4/state-change',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { wrong: 'payload' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('deduplicates repeated events within dedup window', async () => {
    const redis = (app as any).redis;
    // First call: Redis SET NX returns 'OK' (new key)
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const payload = {
      house_id: 'sb-00A3F2', yandex_user_id: 'y', logical_device_id: 'relay-01',
      kind: 'relay', online: true,
      properties: [{ key: 'on', value: true, updated_at: '2026-04-21T10:00:00Z' }],
    };

    await app.inject({
      method: 'POST', url: '/internal/p4/state-change',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload,
    });
    redis.lpush.mockClear();

    // Second call: Redis SET NX returns null (key exists → duplicate)
    await app.inject({
      method: 'POST', url: '/internal/p4/state-change',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` }, payload,
    });

    // lpush should NOT have been called for the duplicate
    expect(redis.lpush).not.toHaveBeenCalled();
  });
});

describe('POST /internal/p4/discovery-change (A5)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('401 — wrong relay token', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/p4/discovery-change', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('202 — valid payload enqueued', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/p4/discovery-change',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { house_id: 'sb-00A3F2', yandex_user_id: 'yandex-uid-123' },
    });
    expect(res.statusCode).toBe(202);
    expect((app as any).redis.lpush).toHaveBeenCalled();
  });

  it('400 — missing yandex_user_id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/p4/discovery-change',
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { house_id: 'sb-00A3F2' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Unlink (A2) ──────────────────────────────────────────────────────────────

describe('POST /v1.0/user/unlink (A2)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(VALID_TOKEN);
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('401 without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1.0/user/unlink' });
    expect(res.statusCode).toBe(401);
  });

  it('200 with request_id on successful unlink', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1.0/user/unlink',
      headers: { authorization: 'Bearer t', 'x-request-id': 'unlink-001' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request_id).toBe('unlink-001');
  });
});

// ─── 404 ─────────────────────────────────────────────────────────────────────

describe('404 handler', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async () => { await app.close(); });

  it('returns 404 with structured error_code', async () => {
    const res = await app.inject({ method: 'GET', url: '/nonexistent/path' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('NOT_FOUND');
  });

  it('does not expose internal paths to Yandex', async () => {
    // Internal paths respond 401 (auth check) not 404 — they exist but are protected.
    const res = await app.inject({ method: 'GET', url: '/internal/p4/state-change' });
    expect(res.statusCode).not.toBe(200);
  });
});

// ─── Replay scenario (A8) ────────────────────────────────────────────────────
// Simulates a Yandex retry: same X-Request-Id sent twice. Both must succeed.

describe('Replay scenario (A8)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(VALID_TOKEN);
    mocks.listDevices.mockResolvedValue([
      { houseId: 'sb-00A3F2', logicalDeviceId: 'relay-01', kind: 'relay', semantics: 'light', name: 'Light', room: 'Hall', boardId: 'b1', meta: null, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now },
    ]);
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('GET /v1.0/user/devices is idempotent with same X-Request-Id', async () => {
    const headers = { authorization: 'Bearer t', 'x-request-id': 'replay-001' };
    const r1 = await app.inject({ method: 'GET', url: '/v1.0/user/devices', headers });
    const r2 = await app.inject({ method: 'GET', url: '/v1.0/user/devices', headers });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // Both return same device list (idempotent read).
    expect(r1.json().payload.devices).toHaveLength(1);
    expect(r2.json().payload.devices).toHaveLength(1);
  });

  it('POST /v1.0/user/devices/action replay returns 200 on both calls', async () => {
    mocks.sendP4DeviceAction.mockResolvedValue({ status: 'ok', request_id: 'r', house_id: 'h', device_id: 'd' });

    const headers = { authorization: 'Bearer t', 'x-request-id': 'replay-action-001' };
    const payload = {
      payload: { devices: [{
        id: 'hi:sb-00A3F2:relay-01',
        capabilities: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }],
      }]},
    };

    const r1 = await app.inject({ method: 'POST', url: '/v1.0/user/devices/action', headers, payload });
    const r2 = await app.inject({ method: 'POST', url: '/v1.0/user/devices/action', headers, payload });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // Both must return DONE — Yandex retries if it doesn't get DONE.
    expect(r1.json().payload.devices[0].capabilities[0].state.action_result.status).toBe('DONE');
    expect(r2.json().payload.devices[0].capabilities[0].state.action_result.status).toBe('DONE');
  });
});

// ─── Correlation chain (A7) ──────────────────────────────────────────────────

describe('Correlation chain (A7)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    mocks.validateBearerToken.mockResolvedValue(VALID_TOKEN);
    app = await buildTestApp();
  });
  afterEach(async () => { await app.close(); vi.clearAllMocks(); });

  it('X-Request-Id from Yandex propagates to response body request_id', async () => {
    mocks.listDevices.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET', url: '/v1.0/user/devices',
      headers: { authorization: 'Bearer t', 'x-request-id': 'yandex-corr-xyz-123' },
    });

    expect(res.json().request_id).toBe('yandex-corr-xyz-123');
    expect(res.headers['x-request-id']).toBe('yandex-corr-xyz-123');
  });
});
