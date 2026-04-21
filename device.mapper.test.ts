/**
 * @file mappers/device.mapper.test.ts
 *
 * Tests for the P4 → Yandex device type mapper.
 * Covers: all 15 supported device kinds, unsupported-kind filtering,
 * device ID format, custom_data payload, capability parameters.
 */

import { describe, it, expect } from 'vitest';
import {
  mapP4DeviceToYandex,
  mapP4InventoryToYandex,
  buildYandexDeviceId,
  parseYandexDeviceId,
} from '../../mappers/device.mapper.js';
import type { P4DeviceDescriptor, P4DeviceKind } from '../../services/p4.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDevice(
  kind: P4DeviceKind,
  overrides: Partial<P4DeviceDescriptor> = {},
): P4DeviceDescriptor {
  return {
    logical_device_id: `dev-001`,
    kind,
    name:     'Test Device',
    room:     'Living Room',
    online:   true,
    board_id: 'board-01',
    ...overrides,
  };
}

const HOUSE_ID = 'sb-00A3F2';

// ─── ID helpers ────────────────────────────────────────────────────────────────

describe('buildYandexDeviceId', () => {
  it('produces hi:{house}:{device} format', () => {
    expect(buildYandexDeviceId('sb-00A3F2', 'relay-42')).toBe('hi:sb-00A3F2:relay-42');
  });
});

describe('parseYandexDeviceId', () => {
  it('parses standard ID', () => {
    const result = parseYandexDeviceId('hi:sb-00A3F2:relay-42');
    expect(result).toEqual({ houseId: 'sb-00A3F2', logicalDeviceId: 'relay-42' });
  });

  it('returns null for IDs not starting with hi:', () => {
    expect(parseYandexDeviceId('other:house:device')).toBeNull();
    expect(parseYandexDeviceId('hi:only-two-parts')).toBeNull();
    expect(parseYandexDeviceId('')).toBeNull();
  });

  it('handles logical_device_id containing colons', () => {
    // If logical_device_id itself ever contains colons, only split on first two colons
    const result = parseYandexDeviceId('hi:sb-00A3F2:complex:device:id');
    expect(result?.houseId).toBe('sb-00A3F2');
    expect(result?.logicalDeviceId).toBe('complex:device:id');
  });
});

// ─── mapP4DeviceToYandex ─────────────────────────────────────────────────────

describe('mapP4DeviceToYandex', () => {

  describe('relay', () => {
    it('maps to devices.types.switch with on_off capability', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('relay'), HOUSE_ID);
      expect(mapped).not.toBeNull();
      expect(mapped!.type).toBe('devices.types.switch');
      expect(mapped!.capabilities).toHaveLength(1);
      expect(mapped!.capabilities[0]!.type).toBe('devices.capabilities.on_off');
      expect(mapped!.properties).toHaveLength(0);
    });
  });

  describe('dimmer', () => {
    it('maps to light with on_off + brightness range', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('dimmer'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.light');
      const types = mapped!.capabilities.map((c) => c.type);
      expect(types).toContain('devices.capabilities.on_off');
      expect(types).toContain('devices.capabilities.range');
    });

    it('uses meta brightness bounds when provided', () => {
      const mapped = mapP4DeviceToYandex(
        makeDevice('dimmer', { meta: { brightness_min: 10, brightness_max: 90 } }),
        HOUSE_ID,
      );
      const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
      const params = rangeCap.parameters as any;
      expect(params.range.min).toBe(10);
      expect(params.range.max).toBe(90);
    });

    it('defaults to 0–100 when no meta', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('dimmer'), HOUSE_ID);
      const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
      const params = rangeCap.parameters as any;
      expect(params.range.min).toBe(0);
      expect(params.range.max).toBe(100);
    });
  });

  describe('pwm', () => {
    it('maps same as dimmer', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('pwm'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.light');
      expect(mapped!.capabilities).toHaveLength(2);
    });
  });

  describe('pwm_rgb', () => {
    it('maps to light with on_off + brightness + color_setting', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('pwm_rgb'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.light');
      const types = mapped!.capabilities.map((c) => c.type);
      expect(types).toContain('devices.capabilities.on_off');
      expect(types).toContain('devices.capabilities.range');
      expect(types).toContain('devices.capabilities.color_setting');
    });

    it('uses HSV color model', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('pwm_rgb'), HOUSE_ID);
      const colorCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.color_setting')!;
      expect((colorCap.parameters as any).color_model).toBe('hsv');
    });
  });

  describe('dali / dali_group', () => {
    it('dali maps to light with brightness', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('dali'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.light');
    });
    it('dali_group maps to light with brightness', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('dali_group'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.light');
    });
  });

  describe('sensors', () => {
    it('ds18b20 maps to sensor with temperature property', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('ds18b20'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.sensor');
      expect(mapped!.capabilities).toHaveLength(0);
      expect(mapped!.properties).toHaveLength(1);
      expect((mapped!.properties[0]!.parameters as any).instance).toBe('temperature');
    });

    it('dht_temp maps to sensor with temperature property', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('dht_temp'), HOUSE_ID);
      expect((mapped!.properties[0]!.parameters as any).instance).toBe('temperature');
    });

    it('dht_humidity maps to sensor with humidity property', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('dht_humidity'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.sensor');
      expect((mapped!.properties[0]!.parameters as any).instance).toBe('humidity');
    });

    it('adc maps to sensor with voltage property', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('adc'), HOUSE_ID);
      expect((mapped!.properties[0]!.parameters as any).instance).toBe('voltage');
    });
  });

  describe('climate_control', () => {
    it('maps to thermostat with on_off + temperature range', () => {
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
  });

  describe('aqua_protect', () => {
    it('maps to openable with on_off', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('aqua_protect'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.openable');
      expect(mapped!.capabilities).toHaveLength(1);
      expect(mapped!.capabilities[0]!.type).toBe('devices.capabilities.on_off');
    });
  });

  describe('curtains', () => {
    it('maps to openable.curtain with on_off + open range', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('curtains'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.openable.curtain');
      const rangeCap = mapped!.capabilities.find((c) => c.type === 'devices.capabilities.range')!;
      expect((rangeCap.parameters as any).instance).toBe('open');
    });
  });

  describe('script / scene', () => {
    it('script maps to other with non-retrievable on_off', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('script'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.other');
      expect(mapped!.capabilities[0]!.retrievable).toBe(false);
    });
    it('scene maps to other with non-retrievable on_off', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('scene'), HOUSE_ID);
      expect(mapped!.type).toBe('devices.types.other');
    });
  });

  describe('unsupported kinds', () => {
    it('returns null for unknown device kind', () => {
      const device = makeDevice('relay' as P4DeviceKind);
      (device as any).kind = 'some_future_device';
      expect(mapP4DeviceToYandex(device, HOUSE_ID)).toBeNull();
    });
  });

  describe('device metadata', () => {
    it('builds correct Yandex device ID', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('relay', { logical_device_id: 'relay-99' }), HOUSE_ID);
      expect(mapped!.id).toBe('hi:sb-00A3F2:relay-99');
    });

    it('includes room when present', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('relay', { room: 'Bedroom' }), HOUSE_ID);
      expect(mapped!.room).toBe('Bedroom');
    });

    it('omits room when absent', () => {
      const device = makeDevice('relay');
      delete (device as any).room;
      const mapped = mapP4DeviceToYandex(device, HOUSE_ID);
      expect(mapped!.room).toBeUndefined();
    });

    it('includes house_id and logical_device_id in custom_data', () => {
      const mapped = mapP4DeviceToYandex(makeDevice('relay', { logical_device_id: 'relay-42' }), HOUSE_ID);
      expect(mapped!.custom_data!['house_id']).toBe(HOUSE_ID);
      expect(mapped!.custom_data!['logical_device_id']).toBe('relay-42');
    });
  });
});

// ─── mapP4InventoryToYandex ───────────────────────────────────────────────────

describe('mapP4InventoryToYandex', () => {
  it('maps all supported devices', () => {
    const devices = [
      makeDevice('relay',   { logical_device_id: 'r1' }),
      makeDevice('dimmer',  { logical_device_id: 'd1' }),
      makeDevice('ds18b20', { logical_device_id: 's1' }),
    ];
    const result = mapP4InventoryToYandex(devices, HOUSE_ID);
    expect(result).toHaveLength(3);
  });

  it('filters out unsupported device kinds', () => {
    const devices = [
      makeDevice('relay', { logical_device_id: 'r1' }),
      { ...makeDevice('relay', { logical_device_id: 'unk1' }), kind: 'unknown_future_device' as any },
    ];
    const result = mapP4InventoryToYandex(devices, HOUSE_ID);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('hi:sb-00A3F2:r1');
  });

  it('returns empty array for empty inventory', () => {
    expect(mapP4InventoryToYandex([], HOUSE_ID)).toEqual([]);
  });
});
