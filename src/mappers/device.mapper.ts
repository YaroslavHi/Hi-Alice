/**
 * @module mappers/device.mapper
 *
 * Maps P4 device descriptors → Yandex Smart Home device objects.
 *
 * STRICT RULE: Only device types and capabilities defined in the Yandex
 * Smart Home REST specification are used here. No invented types.
 * Reference: https://yandex.ru/dev/dialogs/smart-home/doc/en/reference/
 *
 * Mapping table (from CLOUD.md):
 *  relay          → devices.types.switch   + on_off
 *  dimmer         → devices.types.light    + on_off + range(brightness)
 *  pwm            → devices.types.light    + on_off + range(brightness)
 *  pwm_rgb        → devices.types.light    + on_off + range(brightness) + color_setting(hsv)
 *  dali           → devices.types.light    + on_off + range(brightness)
 *  dali_group     → devices.types.light    + on_off + range(brightness)
 *  ds18b20        → devices.types.sensor   + property:temperature
 *  dht_temp       → devices.types.sensor   + property:temperature
 *  dht_humidity   → devices.types.sensor   + property:humidity
 *  adc            → devices.types.sensor   + property:voltage
 *  climate_ctrl   → devices.types.thermostat + on_off + range(temperature)
 *  aqua_protect   → devices.types.openable + on_off (open/close valve)
 *  curtains       → devices.types.openable.curtain + on_off + range(open)
 *  script         → devices.types.other    + on_off (trigger)
 *  scene          → devices.types.other    + on_off (trigger)
 *
 * Device ID format: "hi:{house_id}:{logical_device_id}"
 * This is the stable identifier Yandex uses in all subsequent requests.
 */

import type {
  YandexDevice,
  YandexDeviceType,
  CapabilityDefinition,
  PropertyDefinition,
  RangeCapabilityParameters,
  ColorSettingCapabilityParameters,
} from '../types/yandex.js';
import type { P4DeviceDescriptor } from '../services/p4.service.js';

// ─── Device ID helpers ────────────────────────────────────────────────────────

export function buildYandexDeviceId(houseId: string, logicalDeviceId: string): string {
  return `hi:${houseId}:${logicalDeviceId}`;
}

/**
 * Parse "hi:{house_id}:{logical_device_id}" back to components.
 * Yandex always sends us the full ID string in action/query requests.
 */
export function parseYandexDeviceId(
  yandexId: string,
): { houseId: string; logicalDeviceId: string } | null {
  const parts = yandexId.split(':');
  // Format: hi:<house_id>:<logical_device_id>
  // house_id and logical_device_id may themselves contain colons — take first two segments only.
  if (parts.length < 3 || parts[0] !== 'hi') return null;
  const houseId          = parts[1]!;
  const logicalDeviceId  = parts.slice(2).join(':');
  return { houseId, logicalDeviceId };
}

// ─── Capability builders ──────────────────────────────────────────────────────

function onOffCapability(retrievable = true): CapabilityDefinition {
  return {
    type:        'devices.capabilities.on_off',
    retrievable,
    reportable:  true,
    parameters:  { split: false },
  };
}

function brightnessCapability(
  min = 0,
  max = 100,
  precision = 1,
): CapabilityDefinition {
  return {
    type:        'devices.capabilities.range',
    retrievable: true,
    reportable:  true,
    parameters:  {
      instance:       'brightness',
      random_access:  true,
      range:          { min, max, precision },
      unit:           'unit.percent',
    } satisfies RangeCapabilityParameters,
  };
}

function temperatureSetpointCapability(min: number, max: number): CapabilityDefinition {
  return {
    type:        'devices.capabilities.range',
    retrievable: true,
    reportable:  true,
    parameters:  {
      instance:       'temperature',
      random_access:  true,
      range:          { min, max, precision: 0.5 },
      unit:           'unit.temperature.celsius',
    } satisfies RangeCapabilityParameters,
  };
}

function openPositionCapability(min = 0, max = 100): CapabilityDefinition {
  return {
    type:        'devices.capabilities.range',
    retrievable: true,
    reportable:  true,
    parameters:  {
      instance:       'open',
      random_access:  true,
      range:          { min, max, precision: 1 },
      unit:           'unit.percent',
    } satisfies RangeCapabilityParameters,
  };
}

function hsvColorCapability(): CapabilityDefinition {
  return {
    type:        'devices.capabilities.color_setting',
    retrievable: true,
    reportable:  true,
    parameters:  {
      color_model: 'hsv',
    } satisfies ColorSettingCapabilityParameters,
  };
}

// ─── Property builders ────────────────────────────────────────────────────────

function temperatureProperty(): PropertyDefinition {
  return {
    type:        'devices.properties.float',
    retrievable: true,
    reportable:  true,
    parameters:  { instance: 'temperature', unit: 'unit.temperature.celsius' },
  };
}

function humidityProperty(): PropertyDefinition {
  return {
    type:        'devices.properties.float',
    retrievable: true,
    reportable:  true,
    parameters:  { instance: 'humidity', unit: 'unit.percent' },
  };
}

function voltageProperty(): PropertyDefinition {
  return {
    type:        'devices.properties.float',
    retrievable: true,
    reportable:  true,
    parameters:  { instance: 'voltage', unit: 'unit.volt' },
  };
}

// ─── Per-kind mapping ─────────────────────────────────────────────────────────

interface KindMapping {
  type:         YandexDeviceType;
  capabilities: (device: P4DeviceDescriptor) => CapabilityDefinition[];
  properties:   (device: P4DeviceDescriptor) => PropertyDefinition[];
}

const KIND_MAP: Record<string, KindMapping> = {
  relay: {
    type:         'devices.types.switch',
    capabilities: () => [onOffCapability()],
    properties:   () => [],
  },

  dimmer: {
    type:         'devices.types.light',
    capabilities: (d) => [
      onOffCapability(),
      brightnessCapability(
        d.meta?.brightness_min ?? 0,
        d.meta?.brightness_max ?? 100,
      ),
    ],
    properties: () => [],
  },

  pwm: {
    type:         'devices.types.light',
    capabilities: (d) => [
      onOffCapability(),
      brightnessCapability(
        d.meta?.brightness_min ?? 0,
        d.meta?.brightness_max ?? 100,
      ),
    ],
    properties: () => [],
  },

  pwm_rgb: {
    type:         'devices.types.light',
    capabilities: (d) => {
      const caps: CapabilityDefinition[] = [
        onOffCapability(),
        brightnessCapability(
          d.meta?.brightness_min ?? 0,
          d.meta?.brightness_max ?? 100,
        ),
        hsvColorCapability(),
      ];
      return caps;
    },
    properties: () => [],
  },

  dali: {
    type:         'devices.types.light',
    capabilities: (d) => [
      onOffCapability(),
      brightnessCapability(
        d.meta?.brightness_min ?? 0,
        d.meta?.brightness_max ?? 100,
      ),
    ],
    properties: () => [],
  },

  dali_group: {
    type:         'devices.types.light',
    capabilities: (d) => [
      onOffCapability(),
      brightnessCapability(
        d.meta?.brightness_min ?? 0,
        d.meta?.brightness_max ?? 100,
      ),
    ],
    properties: () => [],
  },

  ds18b20: {
    type:         'devices.types.sensor',
    capabilities: () => [],
    properties:   () => [temperatureProperty()],
  },

  dht_temp: {
    type:         'devices.types.sensor',
    capabilities: () => [],
    properties:   () => [temperatureProperty()],
  },

  dht_humidity: {
    type:         'devices.types.sensor',
    capabilities: () => [],
    properties:   () => [humidityProperty()],
  },

  adc: {
    type:         'devices.types.sensor',
    capabilities: () => [],
    properties:   () => [voltageProperty()],
  },

  climate_control: {
    type:         'devices.types.thermostat',
    capabilities: (d) => [
      onOffCapability(),
      temperatureSetpointCapability(
        d.meta?.temp_setpoint_min ?? 5,
        d.meta?.temp_setpoint_max ?? 35,
      ),
    ],
    properties: () => [],
  },

  aqua_protect: {
    type: 'devices.types.openable',
    // on_off models valve open (true) / closed (false).
    capabilities: () => [onOffCapability()],
    properties:   () => [],
  },

  curtains: {
    type:         'devices.types.openable.curtain',
    capabilities: (d) => [
      onOffCapability(),
      openPositionCapability(
        d.meta?.position_min ?? 0,
        d.meta?.position_max ?? 100,
      ),
    ],
    properties: () => [],
  },

  script: {
    type:         'devices.types.other',
    capabilities: () => [onOffCapability(false)],  // write-only trigger
    properties:   () => [],
  },

  scene: {
    type:         'devices.types.other',
    capabilities: () => [onOffCapability(false)],  // write-only trigger
    properties:   () => [],
  },
};

// ─── Main mapper function ─────────────────────────────────────────────────────

/**
 * Map a single P4 device descriptor to a Yandex Smart Home device object.
 * Returns null if the device kind is not supported (never expose unsupported types).
 */
export function mapP4DeviceToYandex(
  device:  P4DeviceDescriptor,
  houseId: string,
): YandexDevice | null {
  const mapping = KIND_MAP[device.kind];

  // STRICT RULE: NEVER include unsupported device types in discovery.
  if (!mapping) return null;

  const yandexId = buildYandexDeviceId(houseId, device.logical_device_id);

  return {
    id:           yandexId,
    name:         device.name,
    type:         mapping.type,
    ...(device.room !== undefined ? { room: device.room } : {}),
    capabilities: mapping.capabilities(device),
    properties:   mapping.properties(device),
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
 * Map all P4 devices for a house, filtering out unsupported kinds.
 * Logs a debug entry for every skipped device.
 */
export function mapP4InventoryToYandex(
  devices:    P4DeviceDescriptor[],
  houseId:    string,
  log?:       { debug: (obj: object, msg: string) => void },
): YandexDevice[] {
  const result: YandexDevice[] = [];

  for (const device of devices) {
    const mapped = mapP4DeviceToYandex(device, houseId);
    if (!mapped) {
      log?.debug(
        { kind: device.kind, deviceId: device.logical_device_id },
        'Device kind not supported in Yandex — skipped from discovery',
      );
      continue;
    }
    result.push(mapped);
  }

  return result;
}
