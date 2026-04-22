/**
 * Tests for semantic profile resolution and Alice v1 compatibility allowlist.
 *
 * Covers:
 *  - resolveSemanticProfile: all P4 kinds, all semantics labels
 *  - V1_ALLOWED_PROFILES: allowlist membership
 *  - PROFILE_ALLOWED_CAPABILITIES: capability contract per profile
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSemanticProfile,
  V1_ALLOWED_PROFILES,
  PROFILE_ALLOWED_CAPABILITIES,
  type SemanticProfileId,
} from './profiles.js';

// ─── resolveSemanticProfile ───────────────────────────────────────────────────

describe('resolveSemanticProfile', () => {

  describe('relay — ambiguous kind, requires semantics', () => {
    it('relay + "light"  → light.relay', () => {
      expect(resolveSemanticProfile('relay', 'light')).toBe('light.relay');
    });

    it('relay + "socket" → socket.relay', () => {
      expect(resolveSemanticProfile('relay', 'socket')).toBe('socket.relay');
    });

    it('relay + no semantics → null (not discoverable)', () => {
      expect(resolveSemanticProfile('relay', undefined)).toBeNull();
    });

    it('relay + unknown semantics → null', () => {
      expect(resolveSemanticProfile('relay', 'something_unknown')).toBeNull();
    });
  });

  describe('light kinds → light.dimmer', () => {
    const lightKinds = ['dimmer', 'pwm', 'pwm_rgb', 'dali', 'dali_group'] as const;
    for (const kind of lightKinds) {
      it(`${kind} → light.dimmer`, () => {
        expect(resolveSemanticProfile(kind)).toBe('light.dimmer');
      });
      it(`${kind} ignores semantics label`, () => {
        expect(resolveSemanticProfile(kind, 'light')).toBe('light.dimmer');
        expect(resolveSemanticProfile(kind, 'socket')).toBe('light.dimmer');
      });
    }
  });

  describe('curtains → curtain.cover', () => {
    it('curtains → curtain.cover', () => {
      expect(resolveSemanticProfile('curtains')).toBe('curtain.cover');
    });
  });

  describe('climate_control → climate.thermostat.basic', () => {
    it('climate_control → climate.thermostat.basic', () => {
      expect(resolveSemanticProfile('climate_control')).toBe('climate.thermostat.basic');
    });
  });

  describe('climate sensors → sensor.climate.basic', () => {
    it('ds18b20 → sensor.climate.basic', () => {
      expect(resolveSemanticProfile('ds18b20')).toBe('sensor.climate.basic');
    });
    it('dht_temp → sensor.climate.basic', () => {
      expect(resolveSemanticProfile('dht_temp')).toBe('sensor.climate.basic');
    });
    it('dht_humidity → sensor.climate.basic', () => {
      expect(resolveSemanticProfile('dht_humidity')).toBe('sensor.climate.basic');
    });
  });

  describe('excluded from v1 → null', () => {
    it('adc → null (voltage sensor not in v1)', () => {
      expect(resolveSemanticProfile('adc')).toBeNull();
    });
    it('aqua_protect → null (no approved v1 profile)', () => {
      expect(resolveSemanticProfile('aqua_protect')).toBeNull();
    });
    it('script → null (automation trigger not in v1)', () => {
      expect(resolveSemanticProfile('script')).toBeNull();
    });
    it('scene → null (scene trigger not in v1)', () => {
      expect(resolveSemanticProfile('scene')).toBeNull();
    });
  });
});

// ─── V1_ALLOWED_PROFILES ──────────────────────────────────────────────────────

describe('V1_ALLOWED_PROFILES', () => {
  const approved: SemanticProfileId[] = [
    'light.relay',
    'light.dimmer',
    'socket.relay',
    'curtain.cover',
    'climate.thermostat.basic',
    'sensor.climate.basic',
  ];

  for (const profile of approved) {
    it(`contains approved profile: ${profile}`, () => {
      expect(V1_ALLOWED_PROFILES.has(profile)).toBe(true);
    });
  }

  it('has exactly 6 approved profiles', () => {
    expect(V1_ALLOWED_PROFILES.size).toBe(6);
  });

  it('all resolved non-null profiles are in the allowlist', () => {
    const allKinds = ['relay', 'dimmer', 'pwm', 'pwm_rgb', 'dali', 'dali_group',
      'curtains', 'climate_control', 'ds18b20', 'dht_temp', 'dht_humidity'] as const;

    for (const kind of allKinds) {
      const semanticsCases = kind === 'relay' ? ['light', 'socket'] : [undefined];
      for (const sem of semanticsCases) {
        const profile = resolveSemanticProfile(kind, sem);
        if (profile !== null) {
          expect(V1_ALLOWED_PROFILES.has(profile)).toBe(true);
        }
      }
    }
  });
});

// ─── PROFILE_ALLOWED_CAPABILITIES ────────────────────────────────────────────

describe('PROFILE_ALLOWED_CAPABILITIES', () => {
  it('light.relay: only on_off', () => {
    const caps = PROFILE_ALLOWED_CAPABILITIES['light.relay'];
    expect(caps.has('devices.capabilities.on_off')).toBe(true);
    expect(caps.has('devices.capabilities.range')).toBe(false);
    expect(caps.has('devices.capabilities.color_setting')).toBe(false);
  });

  it('socket.relay: only on_off', () => {
    const caps = PROFILE_ALLOWED_CAPABILITIES['socket.relay'];
    expect(caps.has('devices.capabilities.on_off')).toBe(true);
    expect(caps.has('devices.capabilities.range')).toBe(false);
  });

  it('light.dimmer: on_off + range + color_setting', () => {
    const caps = PROFILE_ALLOWED_CAPABILITIES['light.dimmer'];
    expect(caps.has('devices.capabilities.on_off')).toBe(true);
    expect(caps.has('devices.capabilities.range')).toBe(true);
    expect(caps.has('devices.capabilities.color_setting')).toBe(true);
  });

  it('curtain.cover: on_off + range (position)', () => {
    const caps = PROFILE_ALLOWED_CAPABILITIES['curtain.cover'];
    expect(caps.has('devices.capabilities.on_off')).toBe(true);
    expect(caps.has('devices.capabilities.range')).toBe(true);
    expect(caps.has('devices.capabilities.color_setting')).toBe(false);
  });

  it('climate.thermostat.basic: on_off + range (setpoint)', () => {
    const caps = PROFILE_ALLOWED_CAPABILITIES['climate.thermostat.basic'];
    expect(caps.has('devices.capabilities.on_off')).toBe(true);
    expect(caps.has('devices.capabilities.range')).toBe(true);
    expect(caps.has('devices.capabilities.color_setting')).toBe(false);
  });

  it('sensor.climate.basic: no capabilities (read-only)', () => {
    const caps = PROFILE_ALLOWED_CAPABILITIES['sensor.climate.basic'];
    expect(caps.size).toBe(0);
    expect(caps.has('devices.capabilities.on_off')).toBe(false);
  });
});
