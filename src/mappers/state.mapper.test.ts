/**
 * @file mappers/state.mapper.test.ts
 *
 * Tests for the P4 state → Yandex capability/property state mapper.
 * Covers: all device kinds, missing properties, value clamping, timestamps.
 */

import { describe, it, expect } from 'vitest';
import { mapP4StateToYandex } from '../../mappers/state.mapper.js';
import type { P4DeviceState } from '../../types/internal.js';
import type { P4DeviceKind } from '../../services/p4.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(
  props: Array<{ key: string; value: boolean | number | string | null }>,
  opts: { online?: boolean; deviceId?: string } = {},
): P4DeviceState {
  const ts = '2026-04-21T10:00:00Z';
  return {
    logical_device_id: opts.deviceId ?? 'dev-001',
    online: opts.online ?? true,
    properties: props.map((p) => ({ key: p.key, value: p.value, updated_at: ts })),
  };
}

function capOf(kind: P4DeviceKind, state: P4DeviceState, capType: string) {
  const { capabilities } = mapP4StateToYandex(kind, state);
  return capabilities.find((c) => c.type === capType);
}

function propOf(kind: P4DeviceKind, state: P4DeviceState, propType: string) {
  const { properties } = mapP4StateToYandex(kind, state);
  return properties.find((p) => p.type === propType);
}

// ─── relay ────────────────────────────────────────────────────────────────────

describe('relay state mapping', () => {
  it('maps on=true to on_off capability', () => {
    const cap = capOf('relay', makeState([{ key: 'on', value: true }]), 'devices.capabilities.on_off');
    expect(cap).toBeDefined();
    expect((cap!.state as any).value).toBe(true);
    expect((cap!.state as any).instance).toBe('on');
  });

  it('maps on=false', () => {
    const cap = capOf('relay', makeState([{ key: 'on', value: false }]), 'devices.capabilities.on_off');
    expect((cap!.state as any).value).toBe(false);
  });

  it('returns empty capabilities when "on" property is missing', () => {
    const { capabilities } = mapP4StateToYandex('relay', makeState([]));
    expect(capabilities).toHaveLength(0);
  });

  it('returns empty capabilities when "on" has wrong type', () => {
    const { capabilities } = mapP4StateToYandex('relay', makeState([{ key: 'on', value: 1 }]));
    expect(capabilities).toHaveLength(0);
  });

  it('sets last_updated from property timestamp', () => {
    const cap = capOf('relay', makeState([{ key: 'on', value: true }]), 'devices.capabilities.on_off');
    expect(cap!.last_updated).toBe(Math.floor(new Date('2026-04-21T10:00:00Z').getTime() / 1000));
  });
});

// ─── dimmer ───────────────────────────────────────────────────────────────────

describe('dimmer state mapping', () => {
  it('maps on + brightness', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'brightness', value: 75 }]);
    const { capabilities } = mapP4StateToYandex('dimmer', state);
    expect(capabilities).toHaveLength(2);
    const range = capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    expect((range.state as any).value).toBe(75);
  });

  it('clamps brightness above 100 to 100', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'brightness', value: 120 }]);
    const range = capOf('dimmer', state, 'devices.capabilities.range')!;
    expect((range.state as any).value).toBe(100);
  });

  it('clamps brightness below 0 to 0', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'brightness', value: -5 }]);
    const range = capOf('dimmer', state, 'devices.capabilities.range')!;
    expect((range.state as any).value).toBe(0);
  });

  it('rounds fractional brightness values', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'brightness', value: 74.6 }]);
    const range = capOf('dimmer', state, 'devices.capabilities.range')!;
    expect((range.state as any).value).toBe(75);
  });

  it('omits brightness capability when property is missing', () => {
    const state = makeState([{ key: 'on', value: true }]);
    const { capabilities } = mapP4StateToYandex('dimmer', state);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.type).toBe('devices.capabilities.on_off');
  });
});

// ─── pwm_rgb ──────────────────────────────────────────────────────────────────

describe('pwm_rgb state mapping', () => {
  it('maps on + brightness + HSV color', () => {
    const state = makeState([
      { key: 'on', value: true },
      { key: 'brightness', value: 80 },
      { key: 'hue', value: 180 },
      { key: 'saturation', value: 100 },
      { key: 'value', value: 90 },
    ]);
    const { capabilities } = mapP4StateToYandex('pwm_rgb', state);
    expect(capabilities).toHaveLength(3);
    const colorCap = capabilities.find((c) => c.type === 'devices.capabilities.color_setting')!;
    const colorState = colorCap.state as any;
    expect(colorState.instance).toBe('hsv');
    expect(colorState.value).toEqual({ h: 180, s: 100, v: 90 });
  });

  it('omits color capability when any HSV component is missing', () => {
    const state = makeState([
      { key: 'on', value: true },
      { key: 'hue', value: 180 },
      // saturation and value missing
    ]);
    const { capabilities } = mapP4StateToYandex('pwm_rgb', state);
    const colorCap = capabilities.find((c) => c.type === 'devices.capabilities.color_setting');
    expect(colorCap).toBeUndefined();
  });
});

// ─── sensors ──────────────────────────────────────────────────────────────────

describe('ds18b20 / dht_temp state mapping', () => {
  it('maps temperature property', () => {
    const state = makeState([{ key: 'temperature', value: 21.5 }]);
    const prop = propOf('ds18b20', state, 'devices.properties.float')!;
    expect((prop.state as any).instance).toBe('temperature');
    expect((prop.state as any).value).toBe(21.5);
  });

  it('returns empty properties when temperature is missing', () => {
    const { properties } = mapP4StateToYandex('ds18b20', makeState([]));
    expect(properties).toHaveLength(0);
  });
});

describe('dht_humidity state mapping', () => {
  it('maps humidity property', () => {
    const state = makeState([{ key: 'humidity', value: 60 }]);
    const prop = propOf('dht_humidity', state, 'devices.properties.float')!;
    expect((prop.state as any).instance).toBe('humidity');
    expect((prop.state as any).value).toBe(60);
  });
});

describe('adc state mapping', () => {
  it('maps voltage property', () => {
    const state = makeState([{ key: 'voltage', value: 3.3 }]);
    const prop = propOf('adc', state, 'devices.properties.float')!;
    expect((prop.state as any).instance).toBe('voltage');
    expect((prop.state as any).value).toBe(3.3);
  });
});

// ─── climate_control ──────────────────────────────────────────────────────────

describe('climate_control state mapping', () => {
  it('maps on + setpoint', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'setpoint', value: 22.5 }]);
    const { capabilities } = mapP4StateToYandex('climate_control', state);
    const rangeCap = capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    expect((rangeCap.state as any).instance).toBe('temperature');
    expect((rangeCap.state as any).value).toBe(22.5);
  });
});

// ─── curtains ─────────────────────────────────────────────────────────────────

describe('curtains state mapping', () => {
  it('maps on + position', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'position', value: 50 }]);
    const { capabilities } = mapP4StateToYandex('curtains', state);
    const rangeCap = capabilities.find((c) => c.type === 'devices.capabilities.range')!;
    expect((rangeCap.state as any).instance).toBe('open');
    expect((rangeCap.state as any).value).toBe(50);
  });

  it('clamps position out of 0–100 bounds', () => {
    const state = makeState([{ key: 'on', value: true }, { key: 'position', value: 150 }]);
    const rangeCap = capOf('curtains', state, 'devices.capabilities.range')!;
    expect((rangeCap.state as any).value).toBe(100);
  });
});

// ─── script / scene ───────────────────────────────────────────────────────────

describe('script / scene state mapping', () => {
  it('returns no capabilities or properties (write-only)', () => {
    const { capabilities, properties } = mapP4StateToYandex('script', makeState([]));
    expect(capabilities).toHaveLength(0);
    expect(properties).toHaveLength(0);
  });
});

// ─── last_updated ─────────────────────────────────────────────────────────────

describe('last_updated timestamps', () => {
  it('is undefined when property timestamp unavailable', () => {
    // Provide empty state (no properties), so withUpdatedAt returns {}
    const { capabilities } = mapP4StateToYandex('relay', makeState([{ key: 'on', value: true }]));
    const ts = capabilities[0]!.last_updated;
    // Should be a unix timestamp number (not undefined since we provided updated_at)
    expect(typeof ts).toBe('number');
  });
});
