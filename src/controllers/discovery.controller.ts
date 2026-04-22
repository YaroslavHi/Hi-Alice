/**
 * @module controllers/discovery.controller
 *
 * GET /v1.0/user/devices — Yandex Smart Home device discovery endpoint.
 *
 * Yandex spec:
 *   Request:  GET /v1.0/user/devices
 *             Authorization: Bearer {token}
 *             X-Request-Id: {uuid}
 *
 *   Response: HTTP 200
 *     {
 *       "request_id": "{X-Request-Id}",
 *       "payload": {
 *         "user_id": "{yandex_user_id}",
 *         "devices": [ ...YandexDevice[] ]
 *       }
 *     }
 *
 * Architecture rules (from CLOUD.md):
 *  - "Cloud Proxy синхронизирует device list с P4 при каждом GET /devices запросе"
 *    → No local device list cache. Every discovery call goes to P4.
 *  - Cloud Proxy MUST NOT own device state or config.
 *  - Only supported device types exposed (never unsupported).
 *
 * Error strategy:
 *  - P4 offline → 200 with empty device list + warn log
 *    (Yandex spec: return valid response even if house is temporarily unavailable)
 *  - P4 relay network error → 500
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireValidToken } from '../middleware/auth.js';
import { fetchP4Inventory, P4RelayError } from '../services/p4.service.js';
import { mapP4InventoryToYandex } from '../mappers/device.mapper.js';
import type { DevicesDiscoveryResponse } from '../types/yandex.js';

async function handleDiscovery(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const { house_id, yandex_user_id } = request.tokenContext!;

  let inventory;
  try {
    inventory = await fetchP4Inventory(house_id, request.log, request.requestId);
  } catch (err) {
    if (err instanceof P4RelayError) {
      if (err.code === 'house_offline' || err.code === 'not_found') {
        // Per Yandex spec: return valid (empty) response when house temporarily unavailable.
        // Yandex will retry; Alice will show devices as unavailable via the query endpoint.
        request.log.warn(
          { houseId: house_id, error: err.code, requestId: request.requestId },
          'P4 offline during discovery — returning empty device list',
        );
        return reply.code(200).send({
          request_id: request.requestId,
          payload: {
            user_id: yandex_user_id,
            devices: [],
          },
        } satisfies DevicesDiscoveryResponse);
      }

      if (err.code === 'timeout') {
        request.log.error(
          { houseId: house_id, requestId: request.requestId },
          'P4 relay timeout during discovery',
        );
        return reply.code(200).send({
          request_id: request.requestId,
          payload:    { user_id: yandex_user_id, devices: [] },
        } satisfies DevicesDiscoveryResponse);
      }
    }

    // Unexpected relay error — propagate to global error handler → 500.
    throw err;
  }

  const yandexDevices = mapP4InventoryToYandex(
    inventory.devices,
    house_id,
    request.log,
  );

  request.log.info(
    {
      houseId:        house_id,
      totalP4Devices: inventory.devices.length,
      exposedDevices: yandexDevices.length,
      skipped:        inventory.devices.length - yandexDevices.length,
      topologyVersion: inventory.version,
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
  app.get('/v1.0/user/devices', {
    preHandler: [requireValidToken],
  }, handleDiscovery);
}
