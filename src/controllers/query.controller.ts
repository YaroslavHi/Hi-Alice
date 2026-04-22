/**
 * @module controllers/query.controller
 *
 * POST /v1.0/user/devices/query — Yandex Smart Home device state query.
 *
 * Architecture rules:
 *  - Every state read goes through P4 relay — no cache, owner-confirmed only.
 *  - Device semantic profile is resolved SERVER-SIDE from P4 inventory.
 *    custom_data.kind is NOT used as authoritative typing source (DEFECT B fix).
 *  - Devices from other houses are silently rejected (no data leakage).
 *  - P4 relay failure → DEVICE_UNREACHABLE for all requested devices.
 *  - Even partial failure → HTTP 200 with per-device error_code.
 *  - NEVER return HTTP 5xx for device-level failures.
 *
 * Query flow:
 *  1. Validate request body.
 *  2. Fetch P4 inventory to get authoritative device descriptors (kind, semantics).
 *  3. Resolve semantic profile for each device server-side.
 *  4. Query P4 for owner-confirmed state.
 *  5. Map state using authoritative kind from inventory.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireValidToken } from '../middleware/auth.js';
import {
  fetchP4Inventory,
  queryP4DeviceState,
  P4RelayError,
  type P4DeviceKind,
} from '../services/p4.service.js';
import { parseYandexDeviceId } from '../mappers/device.mapper.js';
import { mapP4StateToYandex } from '../mappers/state.mapper.js';
import { resolveSemanticProfile, V1_ALLOWED_PROFILES } from '../semantics/profiles.js';
import type {
  DevicesQueryRequest,
  DevicesQueryResponse,
  DeviceQueryResult,
} from '../types/yandex.js';
import { ALICE_ERROR_CODES } from '../types/internal.js';

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

  // ── Fetch P4 inventory for authoritative device typing ───────────────────────
  // DEFECT B fix: device kind and semantic profile are resolved from the server-side
  // inventory, never from custom_data.kind provided by Yandex in the request.
  let inventoryMap = new Map<string, { kind: P4DeviceKind; semantics: string | undefined }>();
  try {
    const inventory = await fetchP4Inventory(house_id, request.log, request.requestId);
    inventoryMap = new Map(
      inventory.devices.map((d) => [d.logical_device_id, { kind: d.kind, semantics: d.semantics }]),
    );
  } catch (err) {
    if (err instanceof P4RelayError) {
      request.log.error(
        { houseId: house_id, relayError: err.code, requestId: request.requestId },
        'P4 relay failed during inventory fetch — marking all devices unreachable',
      );
      const unreachable: DeviceQueryResult[] = validDevices.map((d) => ({
        id: d.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_UNREACHABLE,
      }));
      return reply.code(200).send({
        request_id: request.requestId,
        payload:    { devices: [...invalidResults, ...unreachable] },
      } satisfies DevicesQueryResponse);
    }
    throw err;
  }

  // ── Classify each valid device using server-side inventory ───────────────────
  type ClassifiedDevice = ValidDevice & { kind: P4DeviceKind };
  const classifiedDevices:   ClassifiedDevice[]   = [];
  const unclassifiedResults: DeviceQueryResult[]  = [];

  for (const dev of validDevices) {
    const descriptor = inventoryMap.get(dev.logicalDeviceId);

    if (!descriptor) {
      // Not found in inventory — device doesn't exist for this house.
      unclassifiedResults.push({
        id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      });
      continue;
    }

    const profile = resolveSemanticProfile(descriptor.kind, descriptor.semantics);
    if (profile === null || !V1_ALLOWED_PROFILES.has(profile)) {
      // Device exists in P4 but has no approved v1 profile.
      // Treat as DEVICE_NOT_FOUND — it shouldn't have been in discovery.
      request.log.warn(
        { deviceId: dev.logicalDeviceId, kind: descriptor.kind, semantics: descriptor.semantics, requestId: request.requestId },
        'Device in query has no v1 semantic profile — returning DEVICE_NOT_FOUND',
      );
      unclassifiedResults.push({
        id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND,
      });
      continue;
    }

    classifiedDevices.push({ ...dev, kind: descriptor.kind });
  }

  // ── Query P4 for owner-confirmed state ───────────────────────────────────────
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
  const stateIndex = new Map(
    stateResponse.devices.map((s) => [s.logical_device_id, s]),
  );

  const deviceResults: DeviceQueryResult[] = classifiedDevices.map((dev) => {
    const p4State = stateIndex.get(dev.logicalDeviceId);

    if (!p4State) {
      return { id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND };
    }

    if (!p4State.online) {
      return { id: dev.yandexId, capabilities: [], properties: [], error_code: ALICE_ERROR_CODES.DEVICE_UNREACHABLE };
    }

    // kind is authoritative — from server-side inventory, not custom_data.
    const { capabilities, properties } = mapP4StateToYandex(dev.kind, p4State);
    return { id: dev.yandexId, capabilities, properties };
  });

  const allResults = [...invalidResults, ...unclassifiedResults, ...deviceResults];

  request.log.info(
    {
      houseId:        house_id,
      requested:      requestedDevices.length,
      classified:     classifiedDevices.length,
      unclassified:   unclassifiedResults.length,
      returned:       allResults.length,
      requestId:      request.requestId,
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
