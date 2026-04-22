/**
 * @module mappers/state.mapper
 *
 * Maps P4 owner-confirmed device state → Yandex capability/property state objects.
 *
 * State mapping rules:
 *  - P4 state is the authoritative source — never invent or cache values.
 *  - If a P4 property is missing for a known capability, the device is reported
 *    as unreachable for that capability (not a guess).
 *  - last_updated is taken from P4's property updated_at timestamp.
 *
 * P4 property key conventions (from MQTT state topics):
 *  on_off devices:     "on"            → boolean
 *  brightness devices: "brightness"    → number 0–100
 *  temperature sensor: "temperature"   → number (°C)
 *  humidity sensor:    "humidity"      → number (0–100 %)
 *  adc/voltage:        "voltage"       → number (V)
 *  temp setpoint:      "setpoint"      → number (°C)
 *  open position:      "position"      → number 0–100
 *  rgb hue:            "hue"           → number 0–360
 *  rgb saturation:     "saturation"    → number 0–100
 *  rgb value:          "value"         → number 0–100
 */

import type {
  CapabilityState,
  PropertyState,
  OnOffCapabilityStateValue,
  RangeCapabilityStateValue,
  ColorSettingCapabilityStateValue,
} from '../types/yandex.js';
import type { P4DeviceState, P4DeviceProperty } from '../types/internal.js';
import type { P4DeviceKind } from '../services/p4.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProp(state: P4DeviceState, key: string): P4DeviceProperty | undefined {
  return state.properties.find((p) => p.key === key);
}

function getNumeric(state: P4DeviceState, key: string): number | null {
  const prop = getProp(state, key);
  return (prop !== null && prop !== undefined && typeof prop.value === 'number')
    ? prop.value
    : null;
}

function getBoolean(state: P4DeviceState, key: string): boolean | null {
  const prop = getProp(state, key);
  return (prop !== null && prop !== undefined && typeof prop.value === 'boolean')
    ? prop.value
    : null;
}

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Returns { last_updated: N } if prop exists, or {} otherwise — safe to spread. */
function withUpdatedAt(state: P4DeviceState, key: string): { last_updated?: number } {
  const prop = getProp(state, key);
  return prop ? { last_updated: isoToUnix(prop.updated_at) } : {};
}

// ─── Capability state builders ────────────────────────────────────────────────

function buildOnOffState(state: P4DeviceState): CapabilityState | null {
  const val = getBoolean(state, 'on');
  if (val === null) return null;

  return {
    type: 'devices.capabilities.on_off',
    state: {
      instance: 'on',
      value:    val,
    } satisfies OnOffCapabilityStateValue,
    ...withUpdatedAt(state, 'on'),
  };
}

function buildBrightnessState(state: P4DeviceState): CapabilityState | null {
  const val = getNumeric(state, 'brightness');
  if (val === null) return null;

  return {
    type: 'devices.capabilities.range',
    state: {
      instance: 'brightness',
      value:    Math.round(Math.min(100, Math.max(0, val))),
    } satisfies RangeCapabilityStateValue,
    ...withUpdatedAt(state, 'brightness'),
  };
}

function buildTemperatureSetpointState(state: P4DeviceState): CapabilityState | null {
  const val = getNumeric(state, 'setpoint');
  if (val === null) return null;

  return {
    type: 'devices.capabilities.range',
    state: {
      instance: 'temperature',
      value:    val,
    } satisfies RangeCapabilityStateValue,
    ...withUpdatedAt(state, 'setpoint'),
  };
}

function buildOpenPositionState(state: P4DeviceState): CapabilityState | null {
  const val = getNumeric(state, 'position');
  if (val === null) return null;

  return {
    type: 'devices.capabilities.range',
    state: {
      instance: 'open',
      value:    Math.round(Math.min(100, Math.max(0, val))),
    } satisfies RangeCapabilityStateValue,
    ...withUpdatedAt(state, 'position'),
  };
}

function buildHsvColorState(state: P4DeviceState): CapabilityState | null {
  const h = getNumeric(state, 'hue');
  const s = getNumeric(state, 'saturation');
  const v = getNumeric(state, 'value');
  if (h === null || s === null || v === null) return null;

  return {
    type: 'devices.capabilities.color_setting',
    state: {
      instance: 'hsv',
      value: { h, s, v },
    } satisfies ColorSettingCapabilityStateValue,
    ...withUpdatedAt(state, 'hue'),
  };
}

// ─── Property state builders ──────────────────────────────────────────────────

function buildTemperaturePropertyState(state: P4DeviceState): PropertyState | null {
  const val = getNumeric(state, 'temperature');
  if (val === null) return null;

  return {
    type:  'devices.properties.float',
    state: { instance: 'temperature', value: val },
    ...withUpdatedAt(state, 'temperature'),
  };
}

function buildHumidityPropertyState(state: P4DeviceState): PropertyState | null {
  const val = getNumeric(state, 'humidity');
  if (val === null) return null;

  return {
    type:  'devices.properties.float',
    state: { instance: 'humidity', value: val },
    ...withUpdatedAt(state, 'humidity'),
  };
}

function buildVoltagePropertyState(state: P4DeviceState): PropertyState | null {
  const val = getNumeric(state, 'voltage');
  if (val === null) return null;

  return {
    type:  'devices.properties.float',
    state: { instance: 'voltage', value: val },
    ...withUpdatedAt(state, 'voltage'),
  };
}

// ─── Per-kind state mapping ───────────────────────────────────────────────────

interface DeviceStateResult {
  capabilities: CapabilityState[];
  properties:   PropertyState[];
}

export function mapP4StateToYandex(
  kind:  P4DeviceKind,
  state: P4DeviceState,
): DeviceStateResult {
  const capabilities: CapabilityState[] = [];
  const properties:   PropertyState[]   = [];

  function addCap(cap: CapabilityState | null): void {
    if (cap !== null) capabilities.push(cap);
  }
  function addProp(prop: PropertyState | null): void {
    if (prop !== null) properties.push(prop);
  }

  switch (kind) {
    case 'relay':
      addCap(buildOnOffState(state));
      break;

    case 'dimmer':
    case 'pwm':
    case 'dali':
    case 'dali_group':
      addCap(buildOnOffState(state));
      addCap(buildBrightnessState(state));
      break;

    case 'pwm_rgb':
      addCap(buildOnOffState(state));
      addCap(buildBrightnessState(state));
      addCap(buildHsvColorState(state));
      break;

    case 'ds18b20':
    case 'dht_temp':
      addProp(buildTemperaturePropertyState(state));
      break;

    case 'dht_humidity':
      addProp(buildHumidityPropertyState(state));
      break;

    case 'adc':
      addProp(buildVoltagePropertyState(state));
      break;

    case 'climate_control':
      addCap(buildOnOffState(state));
      addCap(buildTemperatureSetpointState(state));
      break;

    case 'aqua_protect':
      addCap(buildOnOffState(state));
      break;

    case 'curtains':
      addCap(buildOnOffState(state));
      addCap(buildOpenPositionState(state));
      break;

    case 'script':
    case 'scene':
      // Triggers are write-only; no readable state.
      break;

    default: {
      // Exhaustiveness guard — log unknown kind.
      const _exhaustive: never = kind;
      void _exhaustive;
      break;
    }
  }

  return { capabilities, properties };
}
