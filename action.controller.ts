/**
 * @module controllers/action.controller
 *
 * POST /v1.0/user/devices/action — Yandex Smart Home device action execution.
 *
 * Yandex spec:
 *   Request:  POST /v1.0/user/devices/action
 *             Authorization: Bearer {token}
 *             X-Request-Id: {uuid}
 *             Body: {
 *               "payload": {
 *                 "devices": [
 *                   {
 *                     "id": "hi:house:device",
 *                     "capabilities": [
 *                       { "type": "...", "state": { "instance": "...", "value": ... } }
 *                     ]
 *                   }
 *                 ]
 *               }
 *             }
 *
 *   Response: HTTP 200
 *     {
 *       "request_id": "{X-Request-Id}",
 *       "payload": {
 *         "devices": [
 *           {
 *             "id": "hi:house:device",
 *             "capabilities": [
 *               {
 *                 "type": "...",
 *                 "state": {
 *                   "instance": "...",
 *                   "action_result": { "status": "DONE" | "ERROR", "error_code": "..." }
 *                 }
 *               }
 *             ]
 *           }
 *         ]
 *       }
 *     }
 *
 * Architecture rules:
 *  - Action MUST wait for P4 owner-confirmed result before responding DONE.
 *  - Cloud adapter NEVER speculatively returns DONE before P4 confirms.
 *  - One intent per capability action (P4 handles batching internally).
 *  - Device house_id must match token scope.
 *  - Yandex expects HTTP 200 even for individual device failures.
 *  - NEVER return HTTP 5xx for device-level failures.
 *
 * Concurrency:
 *  - Multiple devices in a single request → parallel relay calls (Promise.allSettled).
 *  - Multiple capabilities on a single device → sequential (P4 processes in order).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireValidToken } from '../middleware/auth.js';
import { sendP4DeviceAction, P4RelayError } from '../services/p4.service.js';
import { parseYandexDeviceId } from '../mappers/device.mapper.js';
import { mapCapabilityAction, buildDeviceSetIntent } from '../mappers/action.mapper.js';
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
  // Map Yandex capability action → P4 property/value.
  const mappingOutcome = mapCapabilityAction(capability);

  if (!mappingOutcome.ok) {
    log.warn(
      { capability: capability.type, instance: (capability.state as any).instance, deviceId: logicalDeviceId, requestId },
      'Capability action mapping failed',
    );
    return {
      type: capability.type,
      state: {
        instance: String((capability.state as any).instance ?? ''),
        action_result: {
          status:     'ERROR',
          error_code: mappingOutcome.error.error_code,
        },
      },
    };
  }

  // Build normalized intent.
  const intent = buildDeviceSetIntent(
    houseId,
    logicalDeviceId,
    mappingOutcome.result,
    requestId,
  );

  // Send to P4 relay — wait for owner-confirmed result.
  let p4Result;
  try {
    p4Result = await sendP4DeviceAction(intent, log, requestId);
  } catch (err) {
    if (err instanceof P4RelayError) {
      const errorCode = err.code === 'timeout'
        ? ALICE_ERROR_CODES.DEVICE_UNREACHABLE
        : err.code === 'house_offline'
        ? ALICE_ERROR_CODES.DEVICE_UNREACHABLE
        : ALICE_ERROR_CODES.INTERNAL_ERROR;

      log.error(
        { deviceId: logicalDeviceId, capability: capability.type, relayError: err.code, requestId },
        'P4 relay error during action',
      );

      return {
        type: capability.type,
        state: {
          instance: String((capability.state as any).instance ?? ''),
          action_result: { status: 'ERROR', error_code: errorCode },
        },
      };
    }
    throw err;
  }

  // Map P4 relay outcome → Yandex action result.
  if (p4Result.status === 'ok') {
    log.debug(
      { deviceId: logicalDeviceId, capability: capability.type, requestId },
      'Action confirmed by P4',
    );
    return {
      type: capability.type,
      state: {
        instance: String((capability.state as any).instance ?? ''),
        action_result: { status: 'DONE' },
      },
    };
  }

  // P4 reported an error.
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
      instance: String((capability.state as any).instance ?? ''),
      action_result: { status: 'ERROR', error_code: errorCode },
    },
  };
}

// ─── Per-device action ────────────────────────────────────────────────────────

async function executeDeviceActions(
  device:    z.infer<typeof actionRequestSchema>['payload']['devices'][number],
  houseId:   string,
  requestId: string,
  log:       FastifyRequest['log'],
): Promise<DeviceActionResult> {
  const parsed = parseYandexDeviceId(device.id);

  if (!parsed) {
    log.warn({ yandexId: device.id, requestId }, 'Unparseable device ID in action request');
    return {
      id: device.id,
      capabilities: device.capabilities.map((cap) => ({
        type: cap.type as CapabilityActionValue['type'],
        state: {
          instance: String((cap.state as any).instance ?? ''),
          action_result: { status: 'ERROR', error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND },
        },
      })),
    };
  }

  if (parsed.houseId !== houseId) {
    log.warn(
      { yandexId: device.id, tokenHouseId: houseId, deviceHouseId: parsed.houseId, requestId },
      'Device house_id mismatch in action request',
    );
    return {
      id: device.id,
      capabilities: device.capabilities.map((cap) => ({
        type: cap.type as CapabilityActionValue['type'],
        state: {
          instance: String((cap.state as any).instance ?? ''),
          action_result: { status: 'ERROR', error_code: ALICE_ERROR_CODES.DEVICE_NOT_FOUND },
        },
      })),
    };
  }

  // Execute capabilities sequentially for this device (order matters — e.g. on then brightness).
  const capResults: CapabilityActionResult[] = [];
  for (const cap of device.capabilities) {
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

  // Execute all devices in parallel (each device's capabilities are sequential internally).
  const settled = await Promise.allSettled(
    devices.map((device) =>
      executeDeviceActions(device, house_id, request.requestId, request.log),
    ),
  );

  const deviceResults: DeviceActionResult[] = settled.map((result, idx) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    // Unexpected rejection — log and return ERROR for all capabilities of this device.
    const device = devices[idx]!;
    request.log.error(
      { deviceId: device.id, err: result.reason, requestId: request.requestId },
      'Unexpected error executing device action',
    );
    return {
      id: device.id,
      capabilities: device.capabilities.map((cap) => ({
        type: cap.type as CapabilityActionValue['type'],
        state: {
          instance: String((cap.state as any).instance ?? ''),
          action_result: { status: 'ERROR', error_code: ALICE_ERROR_CODES.INTERNAL_ERROR },
        },
      })),
    };
  });

  const doneCount  = deviceResults.filter((d) => d.capabilities.every((c) => c.state.action_result.status === 'DONE')).length;
  const errorCount = deviceResults.length - doneCount;

  request.log.info(
    {
      houseId:   house_id,
      devices:   deviceResults.length,
      done:      doneCount,
      errors:    errorCount,
      requestId: request.requestId,
    },
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
