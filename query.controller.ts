/**
 * @module controllers/query.controller
 *
 * POST /v1.0/user/devices/query — Yandex Smart Home device state query.
 *
 * Yandex spec:
 *   Request:  POST /v1.0/user/devices/query
 *             Authorization: Bearer {token}
 *             X-Request-Id: {uuid}
 *             Body: { "devices": [{ "id": "hi:house:device", "custom_data": {...} }] }
 *
 *   Response: HTTP 200
 *     {
 *       "request_id": "{X-Request-Id}",
 *       "payload": {
 *         "devices": [
 *           {
 *             "id": "hi:house:device",
 *             "capabilities": [...],
 *             "properties": [...]
 *           }
 *         ]
 *       }
 *     }
 *
 * Architecture rules:
 *  - Every state read goes through P4 relay — no cache, owner-confirmed only.
 *  - Devices from other houses in the request are silently rejected (wrong token scope).
 *  - If a device is offline, return error_code: "DEVICE_UNREACHABLE" per spec.
 *  - If P4 relay is down, return DEVICE_UNREACHABLE for all requested devices.
 *
 * Per Yandex spec: even if some devices fail, still return 200 with per-device errors.
 * NEVER return HTTP 5xx for individual device failures.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireValidToken } from '../middleware/auth.js';
import { queryP4DeviceState, P4RelayError } from '../services/p4.service.js';
import { parseYandexDeviceId } from '../mappers/device.mapper.js';
import { mapP4StateToYandex } from '../mappers/state.mapper.js';
import type {
  DevicesQueryRequest,
  DevicesQueryResponse,
  DeviceQueryResult,
} from '../types/yandex.js';
import type { P4DeviceKind } from '../services/p4.service.js';
import { ALICE_ERROR_CODES } from '../types/internal.js';

// ─── Request validation ───────────────────────────────────────────────────────

const queryRequestSchema = z.object({
  devices: z.array(
    z.object({
      id:          z.string().min(1),
      custom_data: z.record(z.unknown()).optional(),
    }),
  ).min(1).max(100),   // Yandex sends up to 100 devices per query
});

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleQuery(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const { house_id } = request.tokenContext!;

  // Validate request body.
  const bodyResult = queryRequestSchema.safeParse(request.body as DevicesQueryRequest);
  if (!bodyResult.success) {
    request.log.warn({ issues: bodyResult.error.issues, requestId: request.requestId }, 'Invalid query body');
    return reply.code(400).send({
      request_id:    request.requestId,
      status:        'ERROR',
      error_code:    'VALIDATION_ERROR',
      error_message: 'Invalid request body',
    });
  }

  const { devices: requestedDevices } = bodyResult.data;

  // ── Validate and extract device IDs ─────────────────────────────────────────
  // Filter to only devices belonging to this house (token scope).
  const validDevices: Array<{
    yandexId:        string;
    logicalDeviceId: string;
    kind?:           P4DeviceKind;
  }> = [];

  const invalidResults: DeviceQueryResult[] = [];

  for (const dev of requestedDevices) {
    const parsed = parseYandexDeviceId(dev.id);

    if (!parsed) {
      request.log.warn({ yandexId: dev.id, requestId: request.requestId }, 'Unparseable device ID in query');
      invalidResults.push({
        id:           dev.id,
        capabilities: [],
        properties:   [],
        error_code:   ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      });
      continue;
    }

    if (parsed.houseId !== house_id) {
      // Device belongs to a different house — reject silently (no data leakage).
      request.log.warn(
        { yandexId: dev.id, tokenHouseId: house_id, deviceHouseId: parsed.houseId, requestId: request.requestId },
        'Device house_id mismatch — rejected',
      );
      invalidResults.push({
        id:           dev.id,
        capabilities: [],
        properties:   [],
        error_code:   ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      });
      continue;
    }

    // Extract kind from custom_data if present (avoids extra P4 inventory call).
    const kind = (dev.custom_data?.['kind'] as P4DeviceKind | undefined);

    validDevices.push({
      yandexId:        dev.id,
      logicalDeviceId: parsed.logicalDeviceId,
      ...(kind !== undefined ? { kind } : {}),
    });
  }

  // ── Query P4 for valid devices ───────────────────────────────────────────────
  if (validDevices.length === 0) {
    return reply.code(200).send({
      request_id: request.requestId,
      payload: { devices: invalidResults },
    } satisfies DevicesQueryResponse);
  }

  let stateResponse;
  try {
    stateResponse = await queryP4DeviceState(
      house_id,
      validDevices.map((d) => d.logicalDeviceId),
      request.log,
      request.requestId,
    );
  } catch (err) {
    // P4 relay failure — all valid devices get DEVICE_UNREACHABLE (not HTTP 500).
    if (err instanceof P4RelayError) {
      request.log.error(
        { houseId: house_id, relayError: err.code, requestId: request.requestId },
        'P4 relay failed during state query — marking all devices unreachable',
      );

      const unreachable: DeviceQueryResult[] = validDevices.map((d) => ({
        id:           d.yandexId,
        capabilities: [],
        properties:   [],
        error_code:   ALICE_ERROR_CODES.DEVICE_UNREACHABLE,
      }));

      return reply.code(200).send({
        request_id: request.requestId,
        payload:    { devices: [...invalidResults, ...unreachable] },
      } satisfies DevicesQueryResponse);
    }
    throw err;
  }

  // ── Map P4 states → Yandex format ───────────────────────────────────────────
  const stateIndex = new Map(
    stateResponse.devices.map((s) => [s.logical_device_id, s]),
  );

  const deviceResults: DeviceQueryResult[] = validDevices.map((dev) => {
    const p4State = stateIndex.get(dev.logicalDeviceId);

    if (!p4State) {
      // Device not returned by P4 (unknown ID or not provisioned).
      return {
        id:           dev.yandexId,
        capabilities: [],
        properties:   [],
        error_code:   ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      };
    }

    if (!p4State.online) {
      return {
        id:           dev.yandexId,
        capabilities: [],
        properties:   [],
        error_code:   ALICE_ERROR_CODES.DEVICE_UNREACHABLE,
      };
    }

    // We need the device kind to map state correctly.
    // If custom_data had kind, use it; otherwise we can't map — return unreachable.
    const kind = dev.kind;
    if (!kind) {
      request.log.warn(
        { deviceId: dev.logicalDeviceId, requestId: request.requestId },
        'Device kind missing from custom_data — cannot map state; returning unreachable',
      );
      return {
        id:           dev.yandexId,
        capabilities: [],
        properties:   [],
        error_code:   ALICE_ERROR_CODES.DEVICE_UNREACHABLE,
      };
    }

    const { capabilities, properties } = mapP4StateToYandex(kind, p4State);

    return {
      id:           dev.yandexId,
      capabilities,
      properties,
    };
  });

  const allResults = [...invalidResults, ...deviceResults];

  request.log.info(
    {
      houseId:   house_id,
      requested: requestedDevices.length,
      valid:     validDevices.length,
      returned:  allResults.length,
      requestId: request.requestId,
    },
    'State query completed',
  );

  return reply.code(200).send({
    request_id: request.requestId,
    payload:    { devices: allResults },
  } satisfies DevicesQueryResponse);
}

export async function registerQueryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1.0/user/devices/query', {
    preHandler: [requireValidToken],
  }, handleQuery);
}
