/**
 * @module mappers/device.mapper
 *
 * Maps P4 device descriptors → Yandex Smart Home device objects.
 *
 * DESIGN BASELINE RULE:
 * Yandex device type MUST be determined from USER SEMANTICS (SemanticProfileId),
 * NOT from raw P4 hardware kind. This module:
 *   1. Resolves the semantic profile from (kind, semantics).
 *   2. Filters devices not in the v1 allowlist.
 *   3. Builds Yandex capabilities and properties based on kind-specific hardware.
 *   4. Returns a stable device ID in the required format: "hi:{house_id}:{logical_device_id}".
 *
 * Alice v1 approved profiles → Yandex types:
 *   light.relay              → devices.types.light
 *   light.dimmer             → devices.types.light
 *   socket.relay             → devices.types.socket
 *   curtain.cover            → devices.types.openable.curtain
 *   climate.thermostat.basic → devices.types.thermostat
 *   sensor.climate.basic     → devices.types.sensor.climate
 *
 * NOT included in discovery (silently dropped):
 *   relay without semantics, adc, aqua_protect, script, scene, dali_group
 *   with unknown semantics, etc.
 */

import type {
  YandexDevice,
  YandexDeviceType,
  CapabilityDefinition,
  PropertyDefinition,
  RangeCapabilityParameters,
  ColorSettingCapabilityParameters,
} from '../types/yandex.js';
import type { P4DeviceDescriptor, P4DeviceKind } from '../services/p4.service.js';
import {
  resolveSemanticProfile,
  V1_ALLOWED_PROFILES,
  type SemanticProfileId,
} from '../semantics/profiles.js';

// ─── Device ID helpers ────────────────────────────────────────────────────────

export function buildYandexDeviceId(houseId: string, logicalDeviceId: string): string {
  return `hi:${houseId}:${logicalDeviceId}`;
}

/**
 * Parse "hi:{house_id}:{logical_device_id}" back to components.
 * house_id and logical_device_id may themselves contain colons; we take the
 * first two colon-separated segments only.
 */
export function parseYandexDeviceId(
  yandexId: string,
): { houseId: string; logicalDeviceId: string } | null {
  const parts = yandexId.split(':');
  if (parts.length < 3 || parts[0] !== 'hi') return null;
  const houseId         = parts[1]!;
  const logicalDeviceId = parts.slice(2).join(':');
  return { houseId, logicalDeviceId };
}

// ─── Profile → Yandex device type ────────────────────────────────────────────

const PROFILE_YANDEX_TYPE: Record<SemanticProfileId, YandexDeviceType> = {
  'light.relay':              'devices.types.light',
  'light.dimmer':             'devices.types.light',
  'socket.relay':             'devices.types.socket',
  'curtain.cover':            'devices.types.openable.curtain',
  'climate.thermostat.basic': 'devices.types.thermostat',
  'sensor.climate.basic':     'devices.types.sensor.climate',
};

// ─── Capability builders ──────────────────────────────────────────────────────

function onOffCapability(retrievable = true): CapabilityDefinition {
  return {
    type:       'devices.capabilities.on_off',
    retrievable,
    reportable: true,
    parameters: { split: false },
  };
}

function brightnessCapability(min = 0, max = 100, precision = 1): CapabilityDefinition {
  return {
    type:       'devices.capabilities.range',
    retrievable: true,
    reportable:  true,
    parameters: {
      instance:      'brightness',
      random_access: true,
      range:         { min, max, precision },
      unit:          'unit.percent',
    } satisfies RangeCapabilityParameters,
  };
}

function temperatureSetpointCapability(min: number, max: number): CapabilityDefinition {
  return {
    type:       'devices.capabilities.range',
    retrievable: true,
    reportable:  true,
    parameters: {
      instance:      'temperature',
      random_access: true,
      range:         { min, max, precision: 0.5 },
      unit:          'unit.temperature.celsius',
    } satisfies RangeCapabilityParameters,
  };
}

function openPositionCapability(min = 0, max = 100): CapabilityDefinition {
  return {
    type:       'devices.capabilities.range',
    retrievable: true,
    reportable:  true,
    parameters: {
      instance:      'open',
      random_access: true,
      range:         { min, max, precision: 1 },
      unit:          'unit.percent',
    } satisfies RangeCapabilityParameters,
  };
}

function hsvColorCapability(): CapabilityDefinition {
  return {
    type:       'devices.capabilities.color_setting',
    retrievable: true,
    reportable:  true,
    parameters: {
      color_model: 'hsv',
    } satisfies ColorSettingCapabilityParameters,
  };
}

// ─── Property builders ────────────────────────────────────────────────────────

function temperatureProperty(): PropertyDefinition {
  return {
    type:       'devices.properties.float',
    retrievable: true,
    reportable:  true,
    parameters: { instance: 'temperature', unit: 'unit.temperature.celsius' },
  };
}

function humidityProperty(): PropertyDefinition {
  return {
    type:       'devices.properties.float',
    retrievable: true,
    reportable:  true,
    parameters: { instance: 'humidity', unit: 'unit.percent' },
  };
}

// ─── Kind-specific capability/property builders ───────────────────────────────
// These are called AFTER the profile is resolved, to build the actual Yandex
// capability list based on the underlying hardware kind.

function buildCapabilitiesForKind(
  kind:   P4DeviceKind,
  device: P4DeviceDescriptor,
): CapabilityDefinition[] {
  switch (kind) {
    case 'relay':
      return [onOffCapability()];

    case 'dimmer':
    case 'pwm':
    case 'dali':
    case 'dali_group':
      return [
        onOffCapability(),
        brightnessCapability(
          device.meta?.brightness_min ?? 0,
          device.meta?.brightness_max ?? 100,
        ),
      ];

    case 'pwm_rgb':
      return [
        onOffCapability(),
        brightnessCapability(
          device.meta?.brightness_min ?? 0,
          device.meta?.brightness_max ?? 100,
        ),
        hsvColorCapability(),
      ];

    case 'curtains':
      return [
        onOffCapability(),
        openPositionCapability(
          device.meta?.position_min ?? 0,
          device.meta?.position_max ?? 100,
        ),
      ];

    case 'climate_control':
      return [
        onOffCapability(),
        temperatureSetpointCapability(
          device.meta?.temp_setpoint_min ?? 5,
          device.meta?.temp_setpoint_max ?? 35,
        ),
      ];

    case 'ds18b20':
    case 'dht_temp':
    case 'dht_humidity':
    case 'adc':
    case 'aqua_protect':
    case 'script':
    case 'scene':
      return [];

    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return [];
    }
  }
}

function buildPropertiesForKind(kind: P4DeviceKind): PropertyDefinition[] {
  switch (kind) {
    case 'ds18b20':
    case 'dht_temp':
      return [temperatureProperty()];

    case 'dht_humidity':
      return [humidityProperty()];

    default:
      return [];
  }
}

// ─── Main mapper function ─────────────────────────────────────────────────────

/**
 * Map a single P4 device descriptor to a Yandex Smart Home device object.
 *
 * Returns null if:
 *   - The device kind + semantics cannot be resolved to a v1 semantic profile.
 *   - The resolved profile is not in the V1_ALLOWED_PROFILES allowlist.
 * These devices are silently excluded from discovery.
 */
export function mapP4DeviceToYandex(
  device:  P4DeviceDescriptor,
  houseId: string,
): YandexDevice | null {
  // Resolve semantic profile — this is the authoritative typing step.
  const profile = resolveSemanticProfile(device.kind, device.semantics);

  // STRICT RULE: never expose devices without an approved v1 profile.
  if (profile === null || !V1_ALLOWED_PROFILES.has(profile)) return null;

  const yandexType = PROFILE_YANDEX_TYPE[profile];
  const yandexId   = buildYandexDeviceId(houseId, device.logical_device_id);

  return {
    id:           yandexId,
    name:         device.name,
    type:         yandexType,
    ...(device.room !== undefined ? { room: device.room } : {}),
    capabilities: buildCapabilitiesForKind(device.kind, device),
    properties:   buildPropertiesForKind(device.kind),
    device_info: {
      manufacturer: 'HI SmartBox',
      model:        device.kind,
    },
    custom_data: {
      house_id:          houseId,
      logical_device_id: device.logical_device_id,
      board_id:          device.board_id,
    },
  };
}

/**
 * Map all P4 devices for a house, silently filtering devices without an
 * approved v1 semantic profile. Logs a debug entry for each skipped device.
 */
export function mapP4InventoryToYandex(
  devices: P4DeviceDescriptor[],
  houseId: string,
  log?:    { debug: (obj: object, msg: string) => void },
): YandexDevice[] {
  const result: YandexDevice[] = [];

  for (const device of devices) {
    const mapped = mapP4DeviceToYandex(device, houseId);
    if (!mapped) {
      log?.debug(
        {
          kind:      device.kind,
          semantics: device.semantics ?? '(none)',
          deviceId:  device.logical_device_id,
        },
        'Device excluded from v1 discovery — no approved semantic profile',
      );
      continue;
    }
    result.push(mapped);
  }

  return result;
}
