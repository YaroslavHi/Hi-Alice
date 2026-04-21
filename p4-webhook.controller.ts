/**
 * @module controllers/p4-webhook.controller
 * POST /internal/p4/state-change — P4 relay → alice-adapter state event webhook.
 * POST /internal/p4/discovery-change — P4 relay → alice-adapter device list changed.
 *
 * Both endpoints enqueue into the Redis notification queue (A5).
 * Auth: P4_RELAY_TOKEN Bearer.
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
  app.post('/internal/p4/state-change',     { preHandler: [requireRelayToken] }, handleStateChange);
  app.post('/internal/p4/discovery-change', { preHandler: [requireRelayToken] }, handleDiscoveryChange);
}
