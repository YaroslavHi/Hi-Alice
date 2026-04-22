/**
 * @module controllers/discovery.controller
 *
 * GET /v1.0/user/devices — Yandex Smart Home device discovery.
 *
 * Device inventory is read from the PostgreSQL `devices` table (multi-tenant DB),
 * NOT from the P4 relay. The P4 relay is only called for live state (query/action).
 *
 * Error strategy:
 *   DB unavailable → 200 with empty device list + warn log.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireValidToken } from '../middleware/auth.js';
import { listDevices } from '../services/house.service.js';
import { mapP4InventoryToYandex } from '../mappers/device.mapper.js';
import type { P4DeviceDescriptor, P4DeviceKind } from '../services/p4.service.js';
import type { DeviceRecord } from '../types/internal.js';
import type { DevicesDiscoveryResponse } from '../types/yandex.js';

// ─── DB → P4 descriptor shape ─────────────────────────────────────────────────

function dbDeviceToDescriptor(rec: DeviceRecord): P4DeviceDescriptor {
  return {
    logical_device_id: rec.logicalDeviceId,
    kind:              rec.kind as P4DeviceKind,
    name:              rec.name,
    room:              rec.room,
    online:            true,
    board_id:          rec.boardId ?? '',
    ...(rec.semantics !== null ? { semantics: rec.semantics } : {}),
    ...(rec.meta      !== null ? { meta: rec.meta as NonNullable<P4DeviceDescriptor['meta']> } : {}),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleDiscovery(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const { house_id, yandex_user_id } = request.tokenContext!;

  let devices: DeviceRecord[];
  try {
    devices = await listDevices(request.server.pg, house_id);
  } catch (err) {
    request.log.warn(
      { houseId: house_id, err, requestId: request.requestId },
      'DB error during discovery — returning empty device list',
    );
    return reply.code(200).send({
      request_id: request.requestId,
      payload:    { user_id: yandex_user_id, devices: [] },
    } satisfies DevicesDiscoveryResponse);
  }

  const descriptors   = devices.map(dbDeviceToDescriptor);
  const yandexDevices = mapP4InventoryToYandex(descriptors, house_id, request.log);

  request.log.info(
    {
      houseId:        house_id,
      totalDevices:   devices.length,
      exposedDevices: yandexDevices.length,
      skipped:        devices.length - yandexDevices.length,
      requestId:      request.requestId,
    },
    'Discovery response built',
  );

  return reply.code(200).send({
    request_id: request.requestId,
    payload: {
      user_id: yandex_user_id,
      devices: yandexDevices,
    },
  } satisfies DevicesDiscoveryResponse);
}

export async function registerDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1.0/user/devices', { preHandler: [requireValidToken] }, handleDiscovery);
}
