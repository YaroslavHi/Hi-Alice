/**
 * @file mappers/action.mapper.test.ts
 *
 * Tests for the Yandex capability action → P4 normalized intent mapper.
 * Covers: all supported capability types, invalid values, relative flag,
 * unsupported types, buildDeviceSetIntent.
 */

import { describe, it, expect } from 'vitest';
import {
  mapCapabilityAction,
  buildDeviceSetIntent,
} from './action.mapper.js';
import type { CapabilityActionValue } from '../types/yandex.js';

// ─── on_off ───────────────────────────────────────────────────────────────────

describe('mapCapabilityAction — on_off', () => {
  it('maps on=true', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.on_off',
      state: { instance: 'on', value: true },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.property).toBe('on');
    expect(result.result.value).toBe(true);
  });

  it('maps on=false', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.on_off',
      state: { instance: 'on', value: false },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.value).toBe(false);
  });

  it('rejects non-boolean value', () => {
    const action = {
      type:  'devices.capabilities.on_off',
      state: { instance: 'on', value: 1 },
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error_code).toBe('INVALID_VALUE');
  });

  it('rejects unknown instance', () => {
    const action = {
      type:  'devices.capabilities.on_off',
      state: { instance: 'off', value: true },
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
  });
});

// ─── range ────────────────────────────────────────────────────────────────────

describe('mapCapabilityAction — range', () => {
  const instances = [
    { instance: 'brightness', expectedProperty: 'brightness' },
    { instance: 'temperature', expectedProperty: 'setpoint' },
    { instance: 'open',        expectedProperty: 'position' },
    { instance: 'volume',      expectedProperty: 'volume' },
    { instance: 'channel',     expectedProperty: 'channel' },
  ] as const;

  for (const { instance, expectedProperty } of instances) {
    it(`maps instance=${instance} → property=${expectedProperty}`, () => {
      const action: CapabilityActionValue = {
        type:  'devices.capabilities.range',
        state: { instance, value: 50 },
      };
      const result = mapCapabilityAction(action);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.property).toBe(expectedProperty);
      expect(result.result.value).toBe(50);
    });
  }

  it('passes through relative=true', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.range',
      state: { instance: 'brightness', value: 10, relative: true },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.relative).toBe(true);
  });

  it('passes through relative=false', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.range',
      state: { instance: 'brightness', value: 50, relative: false },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.relative).toBe(false);
  });

  it('rejects non-numeric value', () => {
    const action = {
      type:  'devices.capabilities.range',
      state: { instance: 'brightness', value: 'max' },
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error_code).toBe('INVALID_VALUE');
  });

  it('rejects unsupported instance', () => {
    const action = {
      type:  'devices.capabilities.range',
      state: { instance: 'fan_speed', value: 3 },
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error_code).toBe('INVALID_ACTION');
  });
});

// ─── color_setting ────────────────────────────────────────────────────────────

describe('mapCapabilityAction — color_setting', () => {
  it('maps HSV color', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.color_setting',
      state: { instance: 'hsv', value: { h: 240, s: 100, v: 80 } },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.property).toBe('hsv');
    expect(result.result.value).toEqual({ h: 240, s: 100, v: 80 });
  });

  it('maps RGB color (integer)', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.color_setting',
      state: { instance: 'rgb', value: 0xff0000 },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.property).toBe('rgb');
    expect(result.result.value).toBe(0xff0000);
  });

  it('maps temperature_k', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.color_setting',
      state: { instance: 'temperature_k', value: 4000 },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.property).toBe('color_temp_k');
    expect(result.result.value).toBe(4000);
  });

  it('rejects HSV with missing components', () => {
    const action = {
      type:  'devices.capabilities.color_setting',
      state: { instance: 'hsv', value: { h: 240 } }, // missing s, v
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error_code).toBe('INVALID_VALUE');
  });

  it('rejects RGB with non-number value', () => {
    const action = {
      type:  'devices.capabilities.color_setting',
      state: { instance: 'rgb', value: 'red' },
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown color instance', () => {
    const action = {
      type:  'devices.capabilities.color_setting',
      state: { instance: 'scene', value: 'sunset' },
    } as unknown as CapabilityActionValue;
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
  });
});

// ─── unsupported capability types ─────────────────────────────────────────────

describe('mapCapabilityAction — unsupported types', () => {
  it('returns error for toggle capability', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.toggle',
      state: { instance: 'mute', value: true },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error_code).toBe('NOT_SUPPORTED_IN_CURRENT_MODE');
  });

  it('returns error for mode capability', () => {
    const action: CapabilityActionValue = {
      type:  'devices.capabilities.mode',
      state: { instance: 'thermostat', value: 'heat' },
    };
    const result = mapCapabilityAction(action);
    expect(result.ok).toBe(false);
  });
});

// ─── buildDeviceSetIntent ─────────────────────────────────────────────────────

describe('buildDeviceSetIntent', () => {
  it('builds a valid DeviceSetIntent', () => {
    const intent = buildDeviceSetIntent(
      'sb-00A3F2',
      'relay-42',
      { property: 'on', value: true },
      'req-123',
    );
    expect(intent.type).toBe('device_set');
    expect(intent.house_id).toBe('sb-00A3F2');
    expect(intent.device_id).toBe('relay-42');
    expect(intent.property).toBe('on');
    expect(intent.value).toBe(true);
    expect(intent.request_id).toBe('req-123');
  });

  it('omits relative when undefined', () => {
    const intent = buildDeviceSetIntent('h', 'd', { property: 'on', value: true }, 'r');
    expect('relative' in intent).toBe(false);
  });

  it('includes relative when true', () => {
    const intent = buildDeviceSetIntent('h', 'd', { property: 'brightness', value: 10, relative: true }, 'r');
    expect(intent.relative).toBe(true);
  });
});
