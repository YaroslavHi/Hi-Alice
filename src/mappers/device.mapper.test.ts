/**
 * @file device.mapper.test.ts
 *
 * Tests for the P4 → Yandex device type mapper with semantic profile system.
 *
 * Covers:
 *  - Profile-based Yandex type determination (not raw P4 kind)
 *  - light vs socket semantic split for relay kind
 *  - Climate sensor mapping to devices.types.sensor.climate
 *  - v1 compatibility filtering: adc, aqua_protect, script, scene excluded
 *  - Relay without semantics excluded from discovery
 *  - Capability builders per profile/kind
 *  - custom_data does NOT include 'kind' field
 *  - Device ID format: "hi:{house_id}:{logical_device_id}"
 */

import { describe, it, expect } from 'vitest';
import {
  mapP4DeviceToYandex,
  mapP4InventoryToYandex,
  buildYandexDeviceId,
  parseYandexDeviceId,
} from './device.mapper.js';
import type { P4DeviceDescriptor, P4DeviceKind } from '../services/p4.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDevice(
  kind: P4DeviceKind,
  overrides: Partial<P4DeviceDescriptor> = {},
): P4DeviceDescriptor {
  return {
    logical_device_id: 'dev-001',
    kind,
    name:     'Test Device',
    room:     'Living Room',
    online:   true,
    board_id: 'board-01',
    ...overrides,
  };
}

const HOUSE_ID = 'sb-00A3F2';

// ─── Device ID helpers ────────────────────────────────────────────────────────

describe('buildYandexDeviceId', () => {
  it('produces hi:{house}:{device} format', () => {
    expect(buildYandexDeviceId('sb-00A3F2', 'relay-42')).toBe('hi:sb-00A3F2:relay-42');
  });
});

describe('parseYandexDeviceId', () => {
  it('parses standard ID', () => {
    expect(parseYandexDeviceId('hi:sb-00A3F2:relay-42')).toEqual({
      houseId: 'sb-00A3F2', logicalDeviceId: 'relay-42',
    });
  });

  it('returns null for IDs not starting with hi:', () => {
    expect(parseYandexDeviceId('other:house:device')).toBeNull();
    expect(parseYandexDeviceId('hi:only-two-parts')).toBeNull();
    expect(parseYandexDeviceId('')).toBeNull();
  });

  it('handles logical_device_id containing colons', () => {
    const result = parseYandexDeviceId('hi:sb-00A3F2:complex:device:id');
    expect(result?.houseId).toBe('sb-00A3F2');
    expect(result?.logicalDeviceId).toBe('complex:device:id');
  });
});

// ─── DEFECT A fix: semantic profile determines Yandex type ────────────────────

describe('relay semantic split (light vs socket)', () => {
  it('relay + semantics="light" → devices.types.light', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('relay', { semantics: 'light' }), HOUSE_ID);
    expect(mapped).not.toBeNull();
    expect(mapped!.type).toBe('devices.types.light');
  });

  it('relay + semantics="socket" → devices.types.socket', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('relay', { semantics: 'socket' }), HOUSE_ID);
    expect(mapped).not.toBeNull();
    expect(mapped!.type).toBe('devices.types.socket');
  });

  it('relay + no semantics → null (not discoverable in v1)', () => {
    expect(mapP4DeviceToYandex(makeDevice('relay'), HOUSE_ID)).toBeNull();
  });

  it('relay + unknown semantics → null', () => {
    expect(mapP4DeviceToYandex(makeDevice('relay', { semantics: 'something_else' }), HOUSE_ID)).toBeNull();
  });

  it('relay (light) has on_off capability, no brightness', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('relay', { semantics: 'light' }), HOUSE_ID);
    expect(mapped!.capabilities).toHaveLength(1);
    expect(mapped!.capabilities[0]!.type).toBe('devices.capabilities.on_off');
    expect(mapped!.properties).toHaveLength(0);
  });

  it('relay (socket) has on_off capability only', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('relay', { semantics: 'socket' }), HOUSE_ID);
    expect(mapped!.capabilities).toHaveLength(1);
    expect(mapped!.capabilities[0]!.type).toBe('devices.capabilities.on_off');
  });

  it('relay type was NOT devices.types.switch — old mapping is removed', () => {
    const lightMapped = mapP4DeviceToYandex(makeDevice('relay', { semantics: 'light' }), HOUSE_ID);
    const socketMapped = mapP4DeviceToYandex(makeDevice('relay', { semantics: 'socket' }), HOUSE_ID);
    expect(lightMapped!.type).not.toBe('devices.types.switch');
    expect(socketMapped!.type).not.toBe('devices.types.switch');
  });
});

// ─── DEFECT D fix: climate sensors → devices.types.sensor.climate ─────────────

describe('climate sensor mapping', () => {
  it('ds18b20 → devices.types.sensor.climate with temperature property', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('ds18b20'), HOUSE_ID);
    expect(mapped).not.toBeNull();
    expect(mapped!.type).toBe('devices.types.sensor.climate');
    expect(mapped!.capabilities).toHaveLength(0);
    expect(mapped!.properties).toHaveLength(1);
    expect((mapped!.properties[0]!.parameters as any).instance).toBe('temperature');
  });

  it('dht_temp → devices.types.sensor.climate with temperature', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('dht_temp'), HOUSE_ID);
    expect(mapped!.type).toBe('devices.types.sensor.climate');
    expect((mapped!.properties[0]!.parameters as any).instance).toBe('temperature');
  });

  it('dht_humidity → devices.types.sensor.climate with humidity', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('dht_humidity'), HOUSE_ID);
    expect(mapped!.type).toBe('devices.types.sensor.climate');
    expect((mapped!.properties[0]!.parameters as any).instance).toBe('humidity');
  });

  it('sensors type was NOT devices.types.sensor — old generic mapping removed', () => {
    for (const kind of ['ds18b20', 'dht_temp', 'dht_humidity'] as const) {
      const mapped = mapP4DeviceToYandex(makeDevice(kind), HOUSE_ID);
      expect(mapped!.type).not.toBe('devices.types.sensor');
    }
  });
});

// ─── DEFECT C fix: excluded devices return null ───────────────────────────────

describe('v1 compatibility exclusion (DEFECT C)', () => {
  it('adc → null (voltage sensor not in v1)', () => {
    expect(mapP4DeviceToYandex(makeDevice('adc'), HOUSE_ID)).toBeNull();
  });

  it('aqua_protect → null (no approved v1 profile)', () => {
    expect(mapP4DeviceToYandex(makeDevice('aqua_protect'), HOUSE_ID)).toBeNull();
  });

  it('script → null (automation trigger excluded from v1)', () => {
    expect(mapP4DeviceToYandex(makeDevice('script'), HOUSE_ID)).toBeNull();
  });

  it('scene → null (scene trigger excluded from v1)', () => {
    expect(mapP4DeviceToYandex(makeDevice('scene'), HOUSE_ID)).toBeNull();
  });

  it('unknown future kind → null', () => {
    const device = makeDevice('relay' as P4DeviceKind);
    (device as any).kind = 'future_unknown_kind';
    expect(mapP4DeviceToYandex(device, HOUSE_ID)).toBeNull();
  });
});

// ─── Light dimmer kinds ───────────────────────────────────────────────────────

describe('light dimmer kinds → light.dimmer profile', () => {
  const dimmerKinds = ['dimmer', 'pwm', 'dali', 'dali_group'] as const;

  for (const kind of dimmerKinds) {
    it(`${kind} → devices.types.light with on_off + brightness`, () => {
      const mapped = mapP4DeviceToYandex(makeDevice(kind), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.light');
      const types = mapped!.capabilities.map((c) => c.type);
      expect(types).toContain('devices.capabilities.on_off');
      expect(types).toContain('devices.capabilities.range');
      expect(mapped!.properties).toHaveLength(0);
    });
  }

  it('pwm_rgb → light with on_off + brightness + HSV color', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('pwm_rgb'), HOUSE_ID);
    expect(mapped!.type).toBe('devices.types.light');
    const types = mapped!.capabilities.map((c) => c.type);
    expect(types).toContain('devices.capabilities.on_off');
    expect(types).toContain('devices.capabilities.range');
    expect(types).toContain('devices.capabilities.color_setting');
    const colorCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.color_setting')!;
    expect((colorCap.parameters as any).color_model).toBe('hsv');
  });

  it('dimmer uses meta brightness bounds when provided', () => {
    const mapped = mapP4DeviceToYandex(
      makeDevice('dimmer', { meta: { brightness_min: 10, brightness_max: 90 } }),
      HOUSE_ID,
    );
    const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    const params = rangeCap.parameters as any;
    expect(params.range.min).toBe(10);
    expect(params.range.max).toBe(90);
  });
});

// ─── Curtains ─────────────────────────────────────────────────────────────────

describe('curtains → curtain.cover profile', () => {
  it('curtains → devices.types.openable.curtain with on_off + open range', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('curtains'), HOUSE_ID);
    expect(mapped!.type).toBe('devices.types.openable.curtain');
    const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    expect((rangeCap.parameters as any).instance).toBe('open');
  });
});

// ─── Climate thermostat ───────────────────────────────────────────────────────

describe('climate_control → climate.thermostat.basic', () => {
  it('maps to thermostat with on_off + temperature setpoint', () => {
    const mapped = mapP4DeviceToYandex(
      makeDevice('climate_control', { meta: { temp_setpoint_min: 15, temp_setpoint_max: 30 } }),
      HOUSE_ID,
    );
    expect(mapped!.type).toBe('devices.types.thermostat');
    const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    const params = rangeCap.parameters as any;
    expect(params.instance).toBe('temperature');
    expect(params.range.min).toBe(15);
    expect(params.range.max).toBe(30);
  });

  it('defaults to 5–35°C when no meta', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('climate_control'), HOUSE_ID);
    const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    const params = rangeCap.parameters as any;
    expect(params.range.min).toBe(5);
    expect(params.range.max).toBe(35);
  });
});

// ─── custom_data contract ─────────────────────────────────────────────────────

describe('custom_data contract', () => {
  it('includes house_id and logical_device_id', () => {
    const mapped = mapP4DeviceToYandex(
      makeDevice('dimmer', { logical_device_id: 'dimmer-42' }),
      HOUSE_ID,
    );
    expect(mapped!.custom_data!['house_id']).toBe(HOUSE_ID);
    expect(mapped!.custom_data!['logical_device_id']).toBe('dimmer-42');
    expect(mapped!.custom_data!['board_id']).toBe('board-01');
  });

  it('does NOT include kind in custom_data (server resolves kind from inventory)', () => {
    const mapped = mapP4DeviceToYandex(makeDevice('dimmer'), HOUSE_ID);
    expect(mapped!.custom_data).not.toHaveProperty('kind');
  });
});

// ─── mapP4InventoryToYandex ───────────────────────────────────────────────────

describe('mapP4InventoryToYandex', () => {
  it('includes relay(light), dimmer, sensor.climate devices', () => {
    const devices = [
      makeDevice('relay',   { logical_device_id: 'r1', semantics: 'light' }),
      makeDevice('dimmer',  { logical_device_id: 'd1' }),
      makeDevice('ds18b20', { logical_device_id: 's1' }),
    ];
    const result = mapP4InventoryToYandex(devices, HOUSE_ID);
    expect(result).toHaveLength(3);
  });

  it('silently excludes relay without semantics', () => {
    const devices = [
      makeDevice('relay',  { logical_device_id: 'r-nosem' }),            // excluded
      makeDevice('relay',  { logical_device_id: 'r-light', semantics: 'light' }), // included
    ];
    const result = mapP4InventoryToYandex(devices, HOUSE_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toContain('r-light');
  });

  it('excludes adc, aqua_protect, script, scene from discovery', () => {
    const devices = [
      makeDevice('relay',       { logical_device_id: 'r1', semantics: 'light' }),
      makeDevice('adc',         { logical_device_id: 'adc1' }),
      makeDevice('aqua_protect',{ logical_device_id: 'ap1' }),
      makeDevice('script',      { logical_device_id: 'sc1' }),
      makeDevice('scene',       { logical_device_id: 'se1' }),
    ];
    const result = mapP4InventoryToYandex(devices, HOUSE_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toContain('r1');
  });

  it('returns empty array for empty inventory', () => {
    expect(mapP4InventoryToYandex([], HOUSE_ID)).toEqual([]);
  });

  it('correct Yandex types in mixed inventory', () => {
    const devices = [
      makeDevice('relay',   { logical_device_id: 'r-l', semantics: 'light' }),
      makeDevice('relay',   { logical_device_id: 'r-s', semantics: 'socket' }),
      makeDevice('curtains',{ logical_device_id: 'c1' }),
      makeDevice('dht_temp',{ logical_device_id: 'st1' }),
    ];
    const result = mapP4InventoryToYandex(devices, HOUSE_ID);
    const typeMap = new Map(result.map((d) => [d.id.split(':')[2], d.type]));
    expect(typeMap.get('r-l')).toBe('devices.types.light');
    expect(typeMap.get('r-s')).toBe('devices.types.socket');
    expect(typeMap.get('c1')).toBe('devices.types.openable.curtain');
    expect(typeMap.get('st1')).toBe('devices.types.sensor.climate');
  });
});
