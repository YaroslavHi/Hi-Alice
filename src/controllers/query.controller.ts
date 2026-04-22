/**
 * @module controllers/query.controller
 *
 * POST /v1.0/user/devices/query — Yandex Smart Home device state query.
 *
 * Architecture:
 *   - Device inventory (kind, semantics, meta) read from PostgreSQL `devices` table.
 *   - Live state (on/off, temperature, etc.) queried from P4 relay as before.
 *   - DEFECT B fix: device kind is authoritative from DB, never from custom_data.
 *   - Devices from other houses are silently rejected (no data leakage).
 *   - P4 failure → DEVICE_UNREACHABLE for all requested devices.
 *   - HTTP 200 always; per-device error_code in payload.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireValidToken } from '../middleware/auth.js';
import {
  queryP4DeviceState,
  P4RelayError,
  type P4DeviceKind,
} from '../services/p4.service.js';
import { listDevices } from '../services/house.service.js';
import { parseYandexDeviceId } from '../mappers/device.mapper.js';
import { mapP4StateToYandex } from '../mappers/state.mapper.js';
import { resolveSemanticProfile, V1_ALLOWED_PROFILES } from '../semantics/profiles.js';
import type {
  DevicesQueryRequest,
  DevicesQueryResponse,
  DeviceQueryResult,
} from '../types/yandex.js';
import { ALICE_ERROR_CODES } from '../types/internal.js';
import type { DeviceRecord } from '../types/internal.js';

// ─── Request validation ───────────────────────────────────────────────────────

const queryRequestSchema = z.object({
  devices: z.array(
    z.object({
      id:          z.string().min(1),
      custom_data: z.record(z.unknown()).optional(),
    }),
  ).min(1).max(100),
});

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleQuery(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const { house_id } = request.tokenContext!;

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

  // ── Parse device IDs and validate house scope ────────────────────────────────
  type ValidDevice = { yandexId: string; logicalDeviceId: string };

  const validDevices:   ValidDevice[]       = [];
  const invalidResults: DeviceQueryResult[] = [];

  for (const dev of requestedDevices) {
    const parsed = parseYandexDeviceId(dev.id);
    if (!parsed) {
      request.log.warn({ yandexId: dev.id, requestId: request.requestId }, 'Unparseable device ID in query');
      invalidResults.push({ id: dev.id, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND });
      continue;
    }
    if (parsed.houseId !== house_id) {
      request.log.warn(
        { yandexId: dev.id, tokenHouseId: house_id, deviceHouseId: parsed.houseId, requestId: request.requestId },
        'Device house_id mismatch — rejected',
      );
      invalidResults.push({ id: dev.id, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND });
      continue;
    }
    validDevices.push({ yandexId: dev.id, logicalDeviceId: parsed.logicalDeviceId });
  }

  if (validDevices.length === 0) {
    return reply.code(200).send({
      request_id: request.requestId,
      payload:    { devices: invalidResults },
    } satisfies DevicesQueryResponse);
  }

  // ── Load DB inventory for authoritative device typing ─────────────────────────
  let inventoryMap = new Map<string, { kind: P4DeviceKind; semantics: string | undefined; meta: DeviceRecord['meta'] }>();
  try {
    const dbDevices = await listDevices(request.server.pg, house_id);
    inventoryMap = new Map(
      dbDevices.map((d) => [d.logicalDeviceId, {
        kind:      d.kind as P4DeviceKind,
        semantics: d.semantics ?? undefined,
        meta:      d.meta,
      }]),
    );
  } catch (err) {
    request.log.error(
      { houseId: house_id, err, requestId: request.requestId },
      'DB error during inventory fetch — marking all devices unreachable',
    );
    const unreachable: DeviceQueryResult[] = validDevices.map((d) => ({
      id: d.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_UNREACHABLE,
    }));
    return reply.code(200).send({
      request_id: request.requestId,
      payload:    { devices: [...invalidResults, ...unreachable] },
    } satisfies DevicesQueryResponse);
  }

  // ── Classify each valid device using DB inventory ────────────────────────────
  type ClassifiedDevice = ValidDevice & { kind: P4DeviceKind; semantics: string | undefined; meta: DeviceRecord['meta'] };
  const classifiedDevices:   ClassifiedDevice[]  = [];
  const unclassifiedResults: DeviceQueryResult[] = [];

  for (const dev of validDevices) {
    const descriptor = inventoryMap.get(dev.logicalDeviceId);
    if (!descriptor) {
      unclassifiedResults.push({
        id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      });
      continue;
    }
    const profile = resolveSemanticProfile(descriptor.kind, descriptor.semantics);
    if (profile === null || !V1_ALLOWED_PROFILES.has(profile)) {
      request.log.warn(
        { deviceId: dev.logicalDeviceId, kind: descriptor.kind, semantics: descriptor.semantics, requestId: request.requestId },
        'Device has no v1 semantic profile — returning DEVICE_NOT_FOUND',
      );
      unclassifiedResults.push({
        id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      });
      continue;
    }
    classifiedDevices.push({ ...dev, kind: descriptor.kind, semantics: descriptor.semantics, meta: descriptor.meta });
  }

  // ── Query P4 for live state ──────────────────────────────────────────────────
  let stateResponse;
  try {
    stateResponse = await queryP4DeviceState(
      house_id,
      classifiedDevices.map((d) => d.logicalDeviceId),
      request.log,
      request.requestId,
    );
  } catch (err) {
    if (err instanceof P4RelayError) {
      request.log.error(
        { houseId: house_id, relayError: err.code, requestId: request.requestId },
        'P4 relay failed during state query — marking all devices unreachable',
      );
      const unreachable: DeviceQueryResult[] = classifiedDevices.map((d) => ({
        id: d.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_UNREACHABLE,
      }));
      return reply.code(200).send({
        request_id: request.requestId,
        payload:    { devices: [...invalidResults, ...unclassifiedResults, ...unreachable] },
      } satisfies DevicesQueryResponse);
    }
    throw err;
  }

  // ── Map P4 state → Yandex format ────────────────────────────────────────────
  const stateIndex = new Map(stateResponse.devices.map((s) => [s.logical_device_id, s]));

  const deviceResults: DeviceQueryResult[] = classifiedDevices.map((dev) => {
    const p4State = stateIndex.get(dev.logicalDeviceId);
    if (!p4State) {
      return { id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND };
    }
    if (!p4State.online) {
      return { id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_UNREACHABLE };
    }
    const { capabilities, properties } = mapP4StateToYandex(dev.kind, p4State, {
      ...(dev.meta ?? {}),
      ...(dev.semantics !== undefined ? { semantics: dev.semantics } : {}),
    });
    return { id: dev.yandexId, capabilities, properties };
  });

  const allResults = [...invalidResults, ...unclassifiedResults, ...deviceResults];

  request.log.info(
    {
      houseId:      house_id,
      requested:    requestedDevices.length,
      classified:   classifiedDevices.length,
      unclassified: unclassifiedResults.length,
      returned:     allResults.length,
      requestId:    request.requestId,
    },
    'State query completed',
  );

  return reply.code(200).send({
    request_id: request.requestId,
    payload:    { devices: allResults },
  } satisfies DevicesQueryResponse);
}

export async function registerQueryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1.0/user/devices/query', { preHandler: [requireValidToken] }, handleQuery);
}
