/**
 * @module controllers/admin.controller
 *
 * Admin API — protected by X-Admin-Key header.
 *
 * Houses:
 *   POST   /admin/v1/houses
 *   GET    /admin/v1/houses
 *   GET    /admin/v1/houses/:houseId
 *   PATCH  /admin/v1/houses/:houseId
 *   DELETE /admin/v1/houses/:houseId
 *
 * Devices:
 *   GET    /admin/v1/houses/:houseId/devices
 *   POST   /admin/v1/houses/:houseId/devices
 *   POST   /admin/v1/houses/:houseId/devices/bulk
 *   PATCH  /admin/v1/houses/:houseId/devices/:deviceId
 *   DELETE /admin/v1/houses/:houseId/devices/:deviceId
 *
 * Auth:
 *   POST   /admin/v1/auth/verify
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminKey } from '../middleware/admin-auth.js';
import {
  createHouse,
  getHouse,
  listHouses,
  updateHouse,
  deleteHouse,
  verifyHouseCredentials,
  listAllDevices,
  upsertDevice,
  upsertDevices,
  updateDevice,
  deleteDevice,
} from '../services/house.service.js';

// ─── Validation schemas ───────────────────────────────────────────────────────

const houseCreateSchema = z.object({
  house_id:           z.string().min(1).max(64),
  display_name:       z.string().min(1).max(128),
  owner_login:        z.string().min(1).max(64),
  owner_password:     z.string().min(8),
  mqtt_broker_url:    z.string().url(),
  mqtt_username:      z.string().optional(),
  mqtt_password:      z.string().optional(),
  mqtt_topic_prefix:  z.string().optional(),
});

const houseUpdateSchema = z.object({
  display_name:       z.string().min(1).max(128).optional(),
  owner_login:        z.string().min(1).max(64).optional(),
  owner_password:     z.string().min(8).optional(),
  mqtt_broker_url:    z.string().url().optional(),
  mqtt_username:      z.string().optional(),
  mqtt_password:      z.string().optional(),
  mqtt_topic_prefix:  z.string().optional(),
  active:             z.boolean().optional(),
});

const deviceUpsertSchema = z.object({
  logical_device_id:  z.string().min(1).max(128),
  kind:               z.string().min(1).max(64),
  semantics:          z.string().optional(),
  name:               z.string().min(1).max(256),
  room:               z.string().min(1).max(128),
  board_id:           z.string().optional(),
  meta:               z.record(z.unknown()).optional(),
  enabled:            z.boolean().optional(),
  sort_order:         z.number().int().optional(),
});

const deviceUpdateSchema = z.object({
  kind:               z.string().min(1).max(64).optional(),
  semantics:          z.string().optional(),
  name:               z.string().min(1).max(256).optional(),
  room:               z.string().min(1).max(128).optional(),
  board_id:           z.string().optional(),
  meta:               z.record(z.unknown()).optional(),
  enabled:            z.boolean().optional(),
  sort_order:         z.number().int().optional(),
});

const authVerifySchema = z.object({
  login:    z.string().min(1),
  password: z.string().min(1),
});

// ─── House handlers ───────────────────────────────────────────────────────────

async function handleCreateHouse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = houseCreateSchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'validation_error', issues: r.error.issues });
  }
  try {
    const house = await createHouse(req.server.pg, {
      house_id:           r.data.house_id,
      display_name:       r.data.display_name,
      owner_login:        r.data.owner_login,
      owner_password:     r.data.owner_password,
      mqtt_broker_url:    r.data.mqtt_broker_url,
      ...(r.data.mqtt_username    !== undefined ? { mqtt_username:    r.data.mqtt_username }    : {}),
      ...(r.data.mqtt_password    !== undefined ? { mqtt_password:    r.data.mqtt_password }    : {}),
      ...(r.data.mqtt_topic_prefix !== undefined ? { mqtt_topic_prefix: r.data.mqtt_topic_prefix } : {}),
    });
    return reply.code(201).send({ house });
  } catch (err: any) {
    if (err?.code === '23505') {
      return reply.code(409).send({ error: 'conflict', message: 'house_id or owner_login already exists' });
    }
    throw err;
  }
}

async function handleListHouses(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const houses = await listHouses(req.server.pg);
  return reply.code(200).send({ houses });
}

async function handleGetHouse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId } = req.params as { houseId: string };
  const house = await getHouse(req.server.pg, houseId);
  if (!house) return reply.code(404).send({ error: 'not_found' });
  return reply.code(200).send({ house });
}

async function handleUpdateHouse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId } = req.params as { houseId: string };
  const r = houseUpdateSchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'validation_error', issues: r.error.issues });
  }
  try {
    const house = await updateHouse(req.server.pg, houseId, {
      ...(r.data.display_name      !== undefined ? { display_name:      r.data.display_name }      : {}),
      ...(r.data.owner_login       !== undefined ? { owner_login:       r.data.owner_login }       : {}),
      ...(r.data.owner_password    !== undefined ? { owner_password:    r.data.owner_password }    : {}),
      ...(r.data.mqtt_broker_url   !== undefined ? { mqtt_broker_url:   r.data.mqtt_broker_url }   : {}),
      ...(r.data.mqtt_username     !== undefined ? { mqtt_username:     r.data.mqtt_username }     : {}),
      ...(r.data.mqtt_password     !== undefined ? { mqtt_password:     r.data.mqtt_password }     : {}),
      ...(r.data.mqtt_topic_prefix !== undefined ? { mqtt_topic_prefix: r.data.mqtt_topic_prefix } : {}),
      ...(r.data.active            !== undefined ? { active:            r.data.active }            : {}),
    });
    if (!house) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send({ house });
  } catch (err: any) {
    if (err?.code === '23505') {
      return reply.code(409).send({ error: 'conflict', message: 'owner_login already exists' });
    }
    throw err;
  }
}

async function handleDeleteHouse(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId } = req.params as { houseId: string };
  const deleted = await deleteHouse(req.server.pg, houseId);
  if (!deleted) return reply.code(404).send({ error: 'not_found' });
  return reply.code(204).send();
}

// ─── Device handlers ──────────────────────────────────────────────────────────

async function handleListDevices(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId } = req.params as { houseId: string };
  const house = await getHouse(req.server.pg, houseId);
  if (!house) return reply.code(404).send({ error: 'house_not_found' });
  const devices = await listAllDevices(req.server.pg, houseId);
  return reply.code(200).send({ devices });
}

async function handleUpsertDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId } = req.params as { houseId: string };
  const r = deviceUpsertSchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'validation_error', issues: r.error.issues });
  }
  const house = await getHouse(req.server.pg, houseId);
  if (!house) return reply.code(404).send({ error: 'house_not_found' });

  const device = await upsertDevice(req.server.pg, houseId, {
    logical_device_id: r.data.logical_device_id,
    kind:              r.data.kind,
    name:              r.data.name,
    room:              r.data.room,
    ...(r.data.semantics   !== undefined ? { semantics:   r.data.semantics }   : {}),
    ...(r.data.board_id    !== undefined ? { board_id:    r.data.board_id }    : {}),
    ...(r.data.meta        !== undefined ? { meta:        r.data.meta }        : {}),
    ...(r.data.enabled     !== undefined ? { enabled:     r.data.enabled }     : {}),
    ...(r.data.sort_order  !== undefined ? { sort_order:  r.data.sort_order }  : {}),
  });
  return reply.code(200).send({ device });
}

async function handleBulkUpsertDevices(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId } = req.params as { houseId: string };
  const r = z.object({ devices: z.array(deviceUpsertSchema).min(1).max(500) }).safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'validation_error', issues: r.error.issues });
  }
  const house = await getHouse(req.server.pg, houseId);
  if (!house) return reply.code(404).send({ error: 'house_not_found' });

  const devices = await upsertDevices(req.server.pg, houseId, r.data.devices.map((d) => ({
    logical_device_id: d.logical_device_id,
    kind:              d.kind,
    name:              d.name,
    room:              d.room,
    ...(d.semantics  !== undefined ? { semantics:  d.semantics }  : {}),
    ...(d.board_id   !== undefined ? { board_id:   d.board_id }   : {}),
    ...(d.meta       !== undefined ? { meta:       d.meta }       : {}),
    ...(d.enabled    !== undefined ? { enabled:    d.enabled }    : {}),
    ...(d.sort_order !== undefined ? { sort_order: d.sort_order } : {}),
  })));
  return reply.code(200).send({ devices, count: devices.length });
}

async function handleUpdateDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId, deviceId } = req.params as { houseId: string; deviceId: string };
  const r = deviceUpdateSchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'validation_error', issues: r.error.issues });
  }
  const device = await updateDevice(req.server.pg, houseId, deviceId, {
    ...(r.data.kind       !== undefined ? { kind:       r.data.kind }       : {}),
    ...(r.data.semantics  !== undefined ? { semantics:  r.data.semantics }  : {}),
    ...(r.data.name       !== undefined ? { name:       r.data.name }       : {}),
    ...(r.data.room       !== undefined ? { room:       r.data.room }       : {}),
    ...(r.data.board_id   !== undefined ? { board_id:   r.data.board_id }   : {}),
    ...(r.data.meta       !== undefined ? { meta:       r.data.meta }       : {}),
    ...(r.data.enabled    !== undefined ? { enabled:    r.data.enabled }    : {}),
    ...(r.data.sort_order !== undefined ? { sort_order: r.data.sort_order } : {}),
  });
  if (!device) return reply.code(404).send({ error: 'not_found' });
  return reply.code(200).send({ device });
}

async function handleDeleteDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { houseId, deviceId } = req.params as { houseId: string; deviceId: string };
  const deleted = await deleteDevice(req.server.pg, houseId, deviceId);
  if (!deleted) return reply.code(404).send({ error: 'not_found' });
  return reply.code(204).send();
}

// ─── Auth handler ─────────────────────────────────────────────────────────────

async function handleAuthVerify(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = authVerifySchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send({ error: 'validation_error', issues: r.error.issues });
  }
  const house = await verifyHouseCredentials(req.server.pg, r.data.login, r.data.password);
  if (!house) return reply.code(401).send({ error: 'invalid_credentials' });
  return reply.code(200).send({ house });
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Houses
  app.post('/admin/v1/houses',           { preHandler: [requireAdminKey] }, handleCreateHouse);
  app.get('/admin/v1/houses',            { preHandler: [requireAdminKey] }, handleListHouses);
  app.get('/admin/v1/houses/:houseId',   { preHandler: [requireAdminKey] }, handleGetHouse);
  app.patch('/admin/v1/houses/:houseId', { preHandler: [requireAdminKey] }, handleUpdateHouse);
  app.delete('/admin/v1/houses/:houseId',{ preHandler: [requireAdminKey] }, handleDeleteHouse);

  // Devices
  app.get('/admin/v1/houses/:houseId/devices',                         { preHandler: [requireAdminKey] }, handleListDevices);
  app.post('/admin/v1/houses/:houseId/devices',                        { preHandler: [requireAdminKey] }, handleUpsertDevice);
  app.post('/admin/v1/houses/:houseId/devices/bulk',                   { preHandler: [requireAdminKey] }, handleBulkUpsertDevices);
  app.patch('/admin/v1/houses/:houseId/devices/:deviceId',             { preHandler: [requireAdminKey] }, handleUpdateDevice);
  app.delete('/admin/v1/houses/:houseId/devices/:deviceId',            { preHandler: [requireAdminKey] }, handleDeleteDevice);

  // Auth
  app.post('/admin/v1/auth/verify', { preHandler: [requireAdminKey] }, handleAuthVerify);
}
