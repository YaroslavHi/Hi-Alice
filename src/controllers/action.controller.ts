/**
 * @module controllers/action.controller
 *
 * POST /v1.0/user/devices/action — Yandex Smart Home device action execution.
 *
 * Architecture rules:
 *  - Action MUST wait for P4 owner-confirmed result (MQTT command_result) before DONE.
 *  - Cloud adapter NEVER speculatively returns DONE before P4 confirms.
 *  - Device semantic profile is validated server-side from P4 inventory.
 *  - Capabilities not supported by the device's semantic profile are rejected with
 *    NOT_SUPPORTED_IN_CURRENT_MODE before forwarding to P4.
 *  - Sensor devices (sensor.climate.basic) have no action capabilities — all actions
 *    are rejected at the profile level.
 *  - Multiple devices → parallel relay calls (Promise.allSettled).
 *  - Multiple capabilities per device → sequential (P4 processes in order).
 *  - HTTP 200 always returned; per-capability errors in payload.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireValidToken } from '../middleware/auth.js';
import {
  fetchP4Inventory,
  sendP4DeviceAction,
  P4RelayError,
} from '../services/p4.service.js';
import { parseYandexDeviceId } from '../mappers/device.mapper.js';
import { mapCapabilityAction, buildDeviceSetIntent } from '../mappers/action.mapper.js';
import {
  resolveSemanticProfile,
  V1_ALLOWED_PROFILES,
  PROFILE_ALLOWED_CAPABILITIES,
} from '../semantics/profiles.js';
import type {
  DevicesActionRequest,
  DevicesActionResponse,
  DeviceActionResult,
  CapabilityActionResult,
  CapabilityActionValue,
} from '../types/yandex.js';
import { ALICE_ERROR_CODES } from '../types/internal.js';

// ─── Request validation ───────────────────────────────────────────────────────

const capabilitySchema = z.object({
  type:  z.string().min(1),
  state: z.object({
    instance: z.string().min(1),
    value:    z.unknown(),
    relative: z.boolean().optional(),
  }),
});

const actionRequestSchema = z.object({
  payload: z.object({
    devices: z.array(
      z.object({
        id:           z.string().min(1),
        custom_data:  z.record(z.unknown()).optional(),
        capabilities: z.array(capabilitySchema).min(1),
      }),
    ).min(1).max(100),
  }),
});

// ─── Per-capability action ────────────────────────────────────────────────────

async function executeCapabilityAction(
  capability:      CapabilityActionValue,
  houseId:         string,
  logicalDeviceId: string,
  requestId:       string,
  log:             FastifyRequest['log'],
): Promise<CapabilityActionResult> {
  const mappingOutcome = mapCapabilityAction(capability);

  if (!mappingOutcome.ok) {
    log.warn(
      { capability: capability.type, instance: (capability.state as any).instance, deviceId: logicalDeviceId, requestId },
      'Capability action mapping failed',
    );
    return {
      type: capability.type,
      state: {
        instance:      String((capability.state as any).instance ?? ''),
        action_result: { status: 'ERROR', error_code: mappingOutcome.error.error_code },
      },
    };
  }

  const intent = buildDeviceSetIntent(houseId, logicalDeviceId, mappingOutcome.result, requestId);

  let p4Result;
  try {
    p4Result = await sendP4DeviceAction(intent, log, requestId);
  } catch (err) {
    if (err instanceof P4RelayError) {
      const errorCode =
        err.code === 'timeout' || err.code === 'house_offline'
          ? ALICE_ERROR_CODES.DEVICE_UNREACHABLE
          : ALICE_ERROR_CODES.INTERNAL_ERROR;

      log.error(
        { deviceId: logicalDeviceId, capability: capability.type, relayError: err.code, requestId },
        'P4 relay error during action',
      );
      return {
        type: capability.type,
        state: {
          instance:      String((capability.state as any).instance ?? ''),
          action_result: { status: 'ERROR', error_code: errorCode },
        },
      };
    }
    throw err;
  }

  if (p4Result.status === 'ok') {
    log.debug({ deviceId: logicalDeviceId, capability: capability.type, requestId }, 'Action confirmed by P4');
    return {
      type: capability.type,
      state: {
        instance:      String((capability.state as any).instance ?? ''),
        action_result: { status: 'DONE' },
      },
    };
  }

  const errorCode = (() => {
    switch (p4Result.status) {
      case 'device_not_found': return ALICE_ERROR_CODES.DEVICE_NOT_FOUND;
      case 'timeout':          return ALICE_ERROR_CODES.DEVICE_UNREACHABLE;
      case 'rejected':         return ALICE_ERROR_CODES.NOT_SUPPORTED_IN_CURRENT_MODE;
      default:                 return ALICE_ERROR_CODES.INTERNAL_ERROR;
    }
  })();

  log.warn(
    { deviceId: logicalDeviceId, capability: capability.type, p4Status: p4Result.status, requestId },
    'P4 rejected action',
  );
  return {
    type: capability.type,
    state: {
      instance:      String((capability.state as any).instance ?? ''),
      action_result: { status: 'ERROR', error_code: errorCode },
    },
  };
}

// ─── Reject all capabilities for a device ────────────────────────────────────

function rejectAllCapabilities(
  device:    z.infer<typeof actionRequestSchema>['payload']['devices'][number],
  errorCode: string,
): DeviceActionResult {
  return {
    id:           device.id,
    capabilities: device.capabilities.map((cap) => ({
      type: cap.type as CapabilityActionValue['type'],
      state: {
        instance:      String((cap.state as any).instance ?? ''),
        action_result: { status: 'ERROR', error_code: errorCode },
      },
    })),
  };
}

// ─── Per-device action ────────────────────────────────────────────────────────

async function executeDeviceActions(
  device:      z.infer<typeof actionRequestSchema>['payload']['devices'][number],
  houseId:     string,
  requestId:   string,
  log:         FastifyRequest['log'],
  allowedCaps: ReadonlySet<string> | null,
): Promise<DeviceActionResult> {
  const parsed = parseYandexDeviceId(device.id);

  if (!parsed) {
    log.warn({ yandexId: device.id, requestId }, 'Unparseable device ID in action request');
    return rejectAllCapabilities(device, ALICE_ERROR_CODES.DEVICE_NOT_FOUND);
  }

  if (parsed.houseId !== houseId) {
    log.warn(
      { yandexId: device.id, tokenHouseId: houseId, deviceHouseId: parsed.houseId, requestId },
      'Device house_id mismatch in action request',
    );
    return rejectAllCapabilities(device, ALICE_ERROR_CODES.DEVICE_NOT_FOUND);
  }

  if (allowedCaps === null) {
    // Device not found in inventory or has no v1 profile.
    log.warn({ yandexId: device.id, requestId }, 'Device has no v1 semantic profile — rejecting action');
    return rejectAllCapabilities(device, ALICE_ERROR_CODES.DEVICE_NOT_FOUND);
  }

  const capResults: CapabilityActionResult[] = [];

  for (const cap of device.capabilities) {
    // Profile-level capability validation: reject before sending to P4.
    if (!allowedCaps.has(cap.type)) {
      log.warn(
        { yandexId: device.id, capType: cap.type, requestId },
        'Capability not allowed for device semantic profile',
      );
      capResults.push({
        type: cap.type as CapabilityActionValue['type'],
        state: {
          instance:      String((cap.state as any).instance ?? ''),
          action_result: { status: 'ERROR', error_code: ALICE_ERROR_CODES.NOT_SUPPORTED_IN_CURRENT_MODE },
        },
      });
      continue;
    }

    const result = await executeCapabilityAction(
      cap as CapabilityActionValue,
      houseId,
      parsed.logicalDeviceId,
      requestId,
      log,
    );
    capResults.push(result);
  }

  return { id: device.id, capabilities: capResults };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleAction(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const { house_id } = request.tokenContext!;

  const bodyResult = actionRequestSchema.safeParse(request.body as DevicesActionRequest);
  if (!bodyResult.success) {
    request.log.warn({ issues: bodyResult.error.issues, requestId: request.requestId }, 'Invalid action body');
    return reply.code(400).send({
      request_id:    request.requestId,
      status:        'ERROR',
      error_code:    'VALIDATION_ERROR',
      error_message: 'Invalid request body',
    });
  }

  const { devices } = bodyResult.data.payload;

  // ── Fetch P4 inventory to resolve semantic profiles server-side ──────────────
  const deviceAllowedCaps = new Map<string, ReadonlySet<string> | null>();

  try {
    const inventory = await fetchP4Inventory(house_id, request.log, request.requestId);

    for (const device of devices) {
      const parsed = parseYandexDeviceId(device.id);
      if (!parsed || parsed.houseId !== house_id) {
        deviceAllowedCaps.set(device.id, null);
        continue;
      }
      const descriptor = inventory.devices.find(
        (d) => d.logical_device_id === parsed.logicalDeviceId,
      );
      if (!descriptor) {
        deviceAllowedCaps.set(device.id, null);
        continue;
      }
      const profile = resolveSemanticProfile(descriptor.kind, descriptor.semantics);
      if (profile === null || !V1_ALLOWED_PROFILES.has(profile)) {
        deviceAllowedCaps.set(device.id, null);
        continue;
      }
      deviceAllowedCaps.set(device.id, PROFILE_ALLOWED_CAPABILITIES[profile]);
    }
  } catch (err) {
    if (err instanceof P4RelayError) {
      // Inventory unreachable — reject all devices with DEVICE_UNREACHABLE.
      request.log.error(
        { houseId: house_id, relayError: err.code, requestId: request.requestId },
        'P4 relay inventory fetch failed — cannot validate action profiles',
      );
      const deviceResults: DeviceActionResult[] = devices.map((device) =>
        rejectAllCapabilities(device, ALICE_ERROR_CODES.DEVICE_UNREACHABLE),
      );
      return reply.code(200).send({
        request_id: request.requestId,
        payload:    { devices: deviceResults },
      } satisfies DevicesActionResponse);
    }
    throw err;
  }

  // ── Execute actions in parallel per device ───────────────────────────────────
  const settled = await Promise.allSettled(
    devices.map((device) =>
      executeDeviceActions(
        device,
        house_id,
        request.requestId,
        request.log,
        deviceAllowedCaps.get(device.id) ?? null,
      ),
    ),
  );

  const deviceResults: DeviceActionResult[] = settled.map((result, idx) => {
    if (result.status === 'fulfilled') return result.value;

    const device = devices[idx]!;
    request.log.error(
      { deviceId: device.id, err: result.reason, requestId: request.requestId },
      'Unexpected error executing device action',
    );
    return rejectAllCapabilities(device, ALICE_ERROR_CODES.INTERNAL_ERROR);
  });

  const doneCount  = deviceResults.filter((d) => d.capabilities.every((c) => c.state.action_result.status === 'DONE')).length;
  const errorCount = deviceResults.length - doneCount;

  request.log.info(
    { houseId: house_id, devices: deviceResults.length, done: doneCount, errors: errorCount, requestId: request.requestId },
    'Action request completed',
  );

  return reply.code(200).send({
    request_id: request.requestId,
    payload:    { devices: deviceResults },
  } satisfies DevicesActionResponse);
}

export async function registerActionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1.0/user/devices/action', {
    preHandler: [requireValidToken],
  }, handleAction);
}
