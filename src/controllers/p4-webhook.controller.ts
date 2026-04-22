/**
 * @module controllers/p4-webhook.controller
 *
 * POST /internal/p4/state-change       — legacy: caller provides yandex_user_id
 * POST /internal/p4/discovery-change   — caller provides yandex_user_id
 * POST /internal/p4/house-state-change — new: alice-adapter looks up yandex_user_id from DB
 *
 * All endpoints require Bearer P4_RELAY_TOKEN.
 * State events are enqueued into the Redis notification queue (A5).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z }                           from 'zod';
import { enqueueStateNotification, enqueueDiscoveryNotification } from '../services/notification.service.js';
import { env }                         from '../config/env.js';
import type { P4DeviceKind }           from '../services/p4.service.js';

// ─── Auth ─────────────────────────────────────────────────────────────────────

const requireRelayToken: preHandlerHookHandler = (request, reply, done) => {
  const expected = `Bearer ${env.P4_RELAY_TOKEN}`;
  if (request.headers['authorization'] !== expected) {
    request.log.warn({ ip: request.ip }, 'Unauthorized relay webhook call');
    void reply.code(401).send({ error: 'unauthorized' });
    done();
    return;
  }
  done();
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const propertySchema = z.object({
  key:        z.string(),
  value:      z.union([z.boolean(), z.number(), z.string(), z.null()]),
  updated_at: z.string(),
});

const stateChangeSchema = z.object({
  house_id:          z.string().min(1),
  yandex_user_id:    z.string().min(1),
  logical_device_id: z.string().min(1),
  kind:              z.string().min(1),
  online:            z.boolean(),
  properties:        z.array(propertySchema),
});

const houseStateChangeSchema = z.object({
  house_id:          z.string().min(1),
  logical_device_id: z.string().min(1),
  kind:              z.string().min(1),
  online:            z.boolean(),
  properties:        z.array(propertySchema),
});

const discoveryChangeSchema = z.object({
  house_id:       z.string().min(1),
  yandex_user_id: z.string().min(1),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleStateChange(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = stateChangeSchema.safeParse(req.body);
  if (!r.success) {
    req.log.warn({ issues: r.error.issues }, 'Invalid state-change payload');
    return reply.code(400).send({ error: 'invalid_payload' });
  }
  const { house_id, yandex_user_id, logical_device_id, kind, online, properties } = r.data;

  await enqueueStateNotification(req.server, {
    yandexUserId:    yandex_user_id,
    houseId:         house_id,
    logicalDeviceId: logical_device_id,
    deviceKind:      kind as P4DeviceKind,
    state:           { logical_device_id, online, properties },
  });

  req.server.metrics.inc('alice_notifications_enqueued_total', { kind: 'state' });
  req.log.debug({ houseId: house_id, deviceId: logical_device_id }, 'State change enqueued');
  return reply.code(202).send({ accepted: true });
}

async function handleHouseStateChange(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = houseStateChangeSchema.safeParse(req.body);
  if (!r.success) {
    req.log.warn({ issues: r.error.issues }, 'Invalid house-state-change payload');
    return reply.code(400).send({ error: 'invalid_payload' });
  }
  const { house_id, logical_device_id, kind, online, properties } = r.data;

  // Look up yandex_user_id from the active account link for this house.
  let yandexUserId: string | undefined;
  try {
    const rows = await req.server.pg<{ yandexUserId: string }[]>`
      SELECT yandex_user_id
      FROM alice_account_links
      WHERE hi_house_id = ${house_id}
        AND link_status = 'active'
      LIMIT 1
    `;
    yandexUserId = rows[0]?.yandexUserId;
  } catch (err) {
    req.log.error({ houseId: house_id, err }, 'DB error looking up yandex_user_id for state notification');
    return reply.code(500).send({ error: 'db_error' });
  }

  if (!yandexUserId) {
    req.log.debug({ houseId: house_id }, 'No active account link for house — skipping notification');
    return reply.code(200).send({ skipped: true, reason: 'no_active_link' });
  }

  await enqueueStateNotification(req.server, {
    yandexUserId,
    houseId:         house_id,
    logicalDeviceId: logical_device_id,
    deviceKind:      kind as P4DeviceKind,
    state:           { logical_device_id, online, properties },
  });

  req.server.metrics.inc('alice_notifications_enqueued_total', { kind: 'state' });
  req.log.debug({ houseId: house_id, deviceId: logical_device_id, yandexUserId }, 'House state change enqueued');
  return reply.code(202).send({ accepted: true });
}

async function handleDiscoveryChange(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = discoveryChangeSchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'invalid_payload' });
  }

  await enqueueDiscoveryNotification(req.server, r.data.yandex_user_id);
  req.server.metrics.inc('alice_notifications_enqueued_total', { kind: 'discovery' });
  req.log.debug({ houseId: r.data.house_id }, 'Discovery change enqueued');
  return reply.code(202).send({ accepted: true });
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function registerP4WebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/p4/state-change',       { preHandler: [requireRelayToken] }, handleStateChange);
  app.post('/internal/p4/house-state-change', { preHandler: [requireRelayToken] }, handleHouseStateChange);
  app.post('/internal/p4/discovery-change',   { preHandler: [requireRelayToken] }, handleDiscoveryChange);
}
