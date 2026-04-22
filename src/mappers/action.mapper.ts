/**
 * @module mappers/action.mapper
 *
 * Maps Yandex Smart Home capability action requests → P4 normalized intents.
 *
 * This is the critical translation layer between the Alice/Yandex capability model
 * and the P4 internal device_set intent model.
 *
 * Architecture rule (CLOUD.md):
 *  "Cloud Proxy просто транслирует capability action → normalized intent — никакого parsing"
 *  i.e. this mapper does structural translation only, zero NLU.
 *
 * Action mapping:
 *  on_off / instance=on           → { property: "on",          value: boolean }
 *  range  / instance=brightness   → { property: "brightness",  value: number }
 *  range  / instance=temperature  → { property: "setpoint",    value: number }
 *  range  / instance=open         → { property: "position",    value: number }
 *  color_setting / instance=hsv   → { property: "hsv",         value: {h,s,v} }
 *  color_setting / instance=rgb   → { property: "rgb",         value: number }
 *  color_setting / instance=temperature_k → { property: "color_temp_k", value: number }
 *
 * Relative values (range with relative=true) are passed through to P4;
 * P4 is responsible for computing the absolute value from current state.
 */

import type {
  CapabilityActionValue,
  OnOffCapabilityStateValue,
  RangeCapabilityStateValue,
  ModeCapabilityStateValue,
  ColorSettingCapabilityStateValue,
} from '../types/yandex.js';
import type { DeviceSetIntent } from '../types/internal.js';

export interface ActionMappingResult {
  property:  string;
  value:     boolean | number | string | Record<string, unknown>;
  relative?: boolean;
}

export interface ActionMappingError {
  error_code:    string;
  error_message: string;
}

export type ActionMappingOutcome =
  | { ok: true;  result: ActionMappingResult }
  | { ok: false; error:  ActionMappingError };

/**
 * Map a single Yandex capability action to a P4 property/value pair.
 * Returns an error descriptor if the action cannot be mapped.
 */
export function mapCapabilityAction(
  action: CapabilityActionValue,
): ActionMappingOutcome {
  switch (action.type) {
    case 'devices.capabilities.on_off': {
      const state = action.state as OnOffCapabilityStateValue;
      if (state.instance !== 'on') {
        return { ok: false, error: { error_code: 'INVALID_ACTION', error_message: `Unknown on_off instance: ${state.instance}` } };
      }
      if (typeof state.value !== 'boolean') {
        return { ok: false, error: { error_code: 'INVALID_VALUE', error_message: 'on_off value must be boolean' } };
      }
      return { ok: true, result: { property: 'on', value: state.value } };
    }

    case 'devices.capabilities.range': {
      const state = action.state as RangeCapabilityStateValue;
      if (typeof state.value !== 'number') {
        return { ok: false, error: { error_code: 'INVALID_VALUE', error_message: 'range value must be number' } };
      }

      let property: string;
      switch (state.instance) {
        case 'brightness':   property = 'brightness'; break;
        case 'temperature':  property = 'setpoint';   break;
        case 'open':         property = 'position';   break;
        case 'volume':       property = 'volume';     break;
        case 'channel':      property = 'channel';    break;
        default:
          return { ok: false, error: { error_code: 'INVALID_ACTION', error_message: `Unsupported range instance: ${state.instance}` } };
      }

      return {
        ok: true,
        result: {
          property,
          value:    state.value,
          relative: state.relative ?? false,
        },
      };
    }

    case 'devices.capabilities.color_setting': {
      const state = action.state as ColorSettingCapabilityStateValue;

      switch (state.instance) {
        case 'hsv': {
          const hsv = state.value as { h: number; s: number; v: number };
          if (typeof hsv.h !== 'number' || typeof hsv.s !== 'number' || typeof hsv.v !== 'number') {
            return { ok: false, error: { error_code: 'INVALID_VALUE', error_message: 'HSV value must have numeric h,s,v' } };
          }
          return { ok: true, result: { property: 'hsv', value: hsv } };
        }
        case 'rgb': {
          if (typeof state.value !== 'number') {
            return { ok: false, error: { error_code: 'INVALID_VALUE', error_message: 'RGB value must be number' } };
          }
          return { ok: true, result: { property: 'rgb', value: state.value } };
        }
        case 'temperature_k': {
          if (typeof state.value !== 'number') {
            return { ok: false, error: { error_code: 'INVALID_VALUE', error_message: 'temperature_k value must be number' } };
          }
          return { ok: true, result: { property: 'color_temp_k', value: state.value } };
        }
        default:
          return { ok: false, error: { error_code: 'INVALID_ACTION', error_message: `Unsupported color_setting instance: ${state.instance}` } };
      }
    }

    case 'devices.capabilities.toggle': {
      // Toggle capabilities aren't in our primary device model but handle gracefully.
      return { ok: false, error: { error_code: 'NOT_SUPPORTED_IN_CURRENT_MODE', error_message: 'Toggle not supported for this device' } };
    }

    case 'devices.capabilities.mode': {
      const state = action.state as ModeCapabilityStateValue;
      if (state.instance === 'fan_speed' || state.instance === 'work_speed') {
        const speedMap: Record<string, number> = {
          auto: 0, low: 1, medium: 2, high: 3, turbo: 4, max: 5,
        };
        const speed = speedMap[state.value];
        if (speed === undefined) {
          return { ok: false, error: { error_code: 'INVALID_VALUE', error_message: `Unknown fan speed mode: ${state.value}` } };
        }
        return { ok: true, result: { property: 'speed', value: speed } };
      }
      return { ok: false, error: { error_code: 'NOT_SUPPORTED_IN_CURRENT_MODE', error_message: `Mode instance '${state.instance}' not supported` } };
    }

    case 'devices.capabilities.video_stream': {
      return { ok: false, error: { error_code: 'INVALID_ACTION', error_message: 'Video stream not supported' } };
    }

    default: {
      const _exhaustive: never = action.type;
      void _exhaustive;
      return { ok: false, error: { error_code: 'INVALID_ACTION', error_message: `Unknown capability type: ${action.type}` } };
    }
  }
}

/**
 * Build a DeviceSetIntent from a mapped capability action.
 */
export function buildDeviceSetIntent(
  houseId:         string,
  logicalDeviceId: string,
  mapping:         ActionMappingResult,
  requestId:       string,
): DeviceSetIntent {
  return {
    type:       'device_set',
    house_id:   houseId,
    device_id:  logicalDeviceId,
    property:   mapping.property,
    value:      mapping.value,
    ...(mapping.relative !== undefined ? { relative: mapping.relative } : {}),
    request_id: requestId,
  };
}
