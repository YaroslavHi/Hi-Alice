/**
 * @module semantics/profiles
 *
 * Server-side semantic profile resolution for Alice v1.
 *
 * CRITICAL RULE (design baseline):
 * Yandex device type MUST be determined from USER SEMANTICS, not from raw P4
 * hardware kind. A raw `relay` P4 device can be a light or a socket; the
 * installer sets the `semantics` field in the house config. This module resolves
 * the Alice v1 semantic profile from (kind, semantics) and enforces the v1
 * compatibility allowlist.
 *
 * Approved Alice v1 semantic profiles:
 *   light.relay              → devices.types.light           (on/off)
 *   light.dimmer             → devices.types.light           (on/off, brightness [, HSV])
 *   socket.relay             → devices.types.socket          (on/off)
 *   curtain.cover            → devices.types.openable.curtain (on/off, position)
 *   climate.thermostat.basic → devices.types.thermostat      (on/off, setpoint)
 *   sensor.climate.basic     → devices.types.sensor.climate  (temperature and/or humidity)
 *
 * Excluded from v1 (never discoverable):
 *   adc, aqua_protect, script, scene P4 kinds;
 *   relay without an explicit semantics label;
 *   scene.*, security.*, custom.*, climate.dry, climate.fan_only categories.
 */

import type { P4DeviceKind } from '../services/p4.service.js';

// ─── Approved v1 profile identifiers ─────────────────────────────────────────

export type SemanticProfileId =
  | 'light.relay'
  | 'light.dimmer'
  | 'socket.relay'
  | 'curtain.cover'
  | 'climate.thermostat.basic'
  | 'sensor.climate.basic';

// ─── V1 explicit allowlist ────────────────────────────────────────────────────

/**
 * Explicit allowlist of semantic profiles approved for Alice v1.
 * Any profile NOT in this set must be silently excluded from discovery.
 * This is the single source of truth for v1 compatibility.
 */
export const V1_ALLOWED_PROFILES = new Set<SemanticProfileId>([
  'light.relay',
  'light.dimmer',
  'socket.relay',
  'curtain.cover',
  'climate.thermostat.basic',
  'sensor.climate.basic',
]);

// ─── Profile resolution ───────────────────────────────────────────────────────

/**
 * Resolve the Alice v1 semantic profile from a P4 device descriptor's hardware
 * kind and optional installer-provided semantics label.
 *
 * Resolution contract:
 *   relay + semantics='light'     → 'light.relay'
 *   relay + semantics='socket'    → 'socket.relay'
 *   relay + missing/unknown sem.  → null  (ambiguous; not discoverable)
 *   dimmer / pwm / pwm_rgb / dali / dali_group → 'light.dimmer'
 *   curtains                      → 'curtain.cover'
 *   climate_control               → 'climate.thermostat.basic'
 *   ds18b20 / dht_temp / dht_humidity → 'sensor.climate.basic'
 *   adc                           → null  (voltage; not in v1)
 *   aqua_protect                  → null  (water valve; no approved v1 profile)
 *   script                        → null  (automation trigger; not in v1)
 *   scene                         → null  (scene trigger; not in v1)
 *
 * @param kind      Raw P4 hardware kind from device descriptor.
 * @param semantics Optional semantics label set by installer in house config.
 *                  Required for disambiguation of 'relay'.
 * @returns SemanticProfileId if an approved v1 profile can be resolved,
 *          null if the device must be excluded from discovery entirely.
 */
export function resolveSemanticProfile(
  kind:       P4DeviceKind,
  semantics?: string,
): SemanticProfileId | null {
  switch (kind) {
    case 'relay':
      if (semantics === 'light')  return 'light.relay';
      if (semantics === 'socket') return 'socket.relay';
      return null;

    case 'dimmer':
    case 'pwm':
    case 'pwm_rgb':
    case 'dali':
    case 'dali_group':
      return 'light.dimmer';

    case 'curtains':
      return 'curtain.cover';

    case 'climate_control':
      return 'climate.thermostat.basic';

    case 'ds18b20':
    case 'dht_temp':
    case 'dht_humidity':
      return 'sensor.climate.basic';

    case 'adc':
    case 'aqua_protect':
    case 'script':
    case 'scene':
      return null;

    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return null;
    }
  }
}

// ─── Profile capability contract ──────────────────────────────────────────────

/**
 * Yandex capability types that are valid for each semantic profile.
 * Used in the action controller to reject invalid capability actions
 * before forwarding to P4.
 */
export const PROFILE_ALLOWED_CAPABILITIES: Record<SemanticProfileId, ReadonlySet<string>> = {
  'light.relay': new Set([
    'devices.capabilities.on_off',
  ]),
  'light.dimmer': new Set([
    'devices.capabilities.on_off',
    'devices.capabilities.range',
    'devices.capabilities.color_setting',
  ]),
  'socket.relay': new Set([
    'devices.capabilities.on_off',
  ]),
  'curtain.cover': new Set([
    'devices.capabilities.on_off',
    'devices.capabilities.range',
  ]),
  'climate.thermostat.basic': new Set([
    'devices.capabilities.on_off',
    'devices.capabilities.range',
  ]),
  'sensor.climate.basic': new Set<string>(),  // read-only: no action capabilities
};
