/**
 * @module types/yandex
 *
 * TypeScript types for the Yandex Smart Home REST API.
 * Derived from: https://yandex.ru/dev/dialogs/smart-home/doc/en/reference/
 *
 * STRICT RULE: NEVER invent types that don't exist in the Yandex spec.
 * All types must be traceable to the official API documentation.
 */

// ─── Common ──────────────────────────────────────────────────────────────────

export type RequestStatus = 'DONE' | 'ERROR';

export interface YandexErrorPayload {
  request_id: string;
  status:     'ERROR';
  error_code: string;
  error_message?: string;
}

// ─── Device Types (Yandex canonical values) ──────────────────────────────────

export type YandexDeviceType =
  | 'devices.types.light'
  | 'devices.types.socket'
  | 'devices.types.switch'
  | 'devices.types.thermostat'
  | 'devices.types.thermostat.ac'
  | 'devices.types.media_device'
  | 'devices.types.media_device.tv'
  | 'devices.types.media_device.tv_box'
  | 'devices.types.media_device.receiver'
  | 'devices.types.smart_speaker'
  | 'devices.types.other'
  | 'devices.types.vacuum_cleaner'
  | 'devices.types.washing_machine'
  | 'devices.types.dishwasher'
  | 'devices.types.iron'
  | 'devices.types.sensor'
  | 'devices.types.sensor.climate'
  | 'devices.types.sensor.motion'
  | 'devices.types.sensor.door'
  | 'devices.types.sensor.window'
  | 'devices.types.sensor.water_leak'
  | 'devices.types.sensor.smoke'
  | 'devices.types.sensor.gas'
  | 'devices.types.sensor.vibration'
  | 'devices.types.sensor.button'
  | 'devices.types.openable'
  | 'devices.types.openable.curtain'
  | 'devices.types.cooking'
  | 'devices.types.cooking.kettle'
  | 'devices.types.cooking.coffee_maker'
  | 'devices.types.cooking.multicooker'
  | 'devices.types.humidifier'
  | 'devices.types.purifier'
  | 'devices.types.pet_feeder'
  | 'devices.types.camera';

// ─── Capability Types ─────────────────────────────────────────────────────────

export type CapabilityType =
  | 'devices.capabilities.on_off'
  | 'devices.capabilities.color_setting'
  | 'devices.capabilities.range'
  | 'devices.capabilities.mode'
  | 'devices.capabilities.toggle'
  | 'devices.capabilities.video_stream';

// ─── On/Off ───────────────────────────────────────────────────────────────────

export interface OnOffCapabilityParameters {
  split?: boolean;
}

export interface OnOffCapabilityStateValue {
  instance: 'on';
  value:    boolean;
}

// ─── Range ────────────────────────────────────────────────────────────────────

export type RangeInstance =
  | 'brightness'
  | 'channel'
  | 'humidity'
  | 'open'
  | 'temperature'
  | 'volume'
  | 'speed'
  | 'fan_speed';

export interface RangeCapabilityParameters {
  instance:   RangeInstance;
  random_access?: boolean;
  range?: {
    min:  number;
    max:  number;
    precision: number;
  };
  unit?: string;
}

export interface RangeCapabilityStateValue {
  instance:  RangeInstance;
  value:     number;
  relative?: boolean;
}

// ─── Mode ─────────────────────────────────────────────────────────────────────

export type ModeInstance =
  | 'cleanup_mode'
  | 'coffee_mode'
  | 'dishwashing'
  | 'fan_speed'
  | 'heat'
  | 'input_source'
  | 'program'
  | 'swing'
  | 'tea_mode'
  | 'thermostat'
  | 'work_speed';

export interface ModeCapabilityParameters {
  instance: ModeInstance;
  modes:    Array<{ value: string }>;
}

export interface ModeCapabilityStateValue {
  instance: ModeInstance;
  value:    string;
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

export type ToggleInstance =
  | 'backlight'
  | 'controls_locked'
  | 'ionization'
  | 'keep_warm'
  | 'mute'
  | 'oscillation'
  | 'pause';

export interface ToggleCapabilityParameters {
  instance: ToggleInstance;
}

export interface ToggleCapabilityStateValue {
  instance: ToggleInstance;
  value:    boolean;
}

// ─── Color Setting ────────────────────────────────────────────────────────────

export interface ColorSettingCapabilityParameters {
  color_model?: 'hsv' | 'rgb';
  temperature_k?: {
    min: number;
    max: number;
  };
}

export interface ColorHSV {
  h: number; // 0–360
  s: number; // 0–100
  v: number; // 0–100
}

export interface ColorRGB {
  r: number; // 0–255
  g: number; // 0–255
  b: number; // 0–255
}

export type ColorSettingInstance = 'base' | 'rgb' | 'hsv' | 'temperature_k' | 'scene';

export interface ColorSettingCapabilityStateValue {
  instance: ColorSettingInstance;
  value:    number | ColorHSV | ColorRGB;
}

// ─── Discriminated union for capability params & state ───────────────────────

export type CapabilityParameters =
  | OnOffCapabilityParameters
  | RangeCapabilityParameters
  | ModeCapabilityParameters
  | ToggleCapabilityParameters
  | ColorSettingCapabilityParameters;

export type CapabilityStateValue =
  | OnOffCapabilityStateValue
  | RangeCapabilityStateValue
  | ModeCapabilityStateValue
  | ToggleCapabilityStateValue
  | ColorSettingCapabilityStateValue;

// ─── Capability (full object used in discovery & query) ──────────────────────

export interface CapabilityState {
  type:          CapabilityType;
  state:         CapabilityStateValue;
  last_updated?: number | undefined;
}

export interface CapabilityDefinition {
  type:         CapabilityType;
  retrievable:  boolean;
  reportable:   boolean;
  parameters:   CapabilityParameters;
}

// ─── Property Types (sensors / float properties) ─────────────────────────────

export type PropertyType =
  | 'devices.properties.float'
  | 'devices.properties.event';

export type FloatPropertyInstance =
  | 'amperage'
  | 'battery_level'
  | 'co2_level'
  | 'electricity_meter'
  | 'food_level'
  | 'gas_meter'
  | 'heat_meter'
  | 'humidity'
  | 'illumination'
  | 'meter'
  | 'pm1_density'
  | 'pm2.5_density'
  | 'pm10_density'
  | 'power'
  | 'pressure'
  | 'temperature'
  | 'tvoc'
  | 'voltage'
  | 'water_level'
  | 'water_meter';

export type EventPropertyInstance =
  | 'battery_level'
  | 'button'
  | 'food_level'
  | 'gas'
  | 'motion'
  | 'open'
  | 'smoke'
  | 'vibration'
  | 'water_leak';

export interface FloatPropertyParameters {
  instance: FloatPropertyInstance;
  unit?:    string;
}

export interface EventPropertyParameters {
  instance: EventPropertyInstance;
  events:   Array<{ value: string }>;
}

export type PropertyParameters = FloatPropertyParameters | EventPropertyParameters;

export interface PropertyDefinition {
  type:        PropertyType;
  retrievable: boolean;
  reportable:  boolean;
  parameters:  PropertyParameters;
}

export interface PropertyState {
  type:          PropertyType;
  state: {
    instance: string;
    value:    number | string;
  };
  last_updated?: number | undefined;
}

// ─── Device (discovery response) ─────────────────────────────────────────────

export interface YandexDevice {
  id:           string;
  name:         string;
  description?: string | undefined;
  room?:        string | undefined;
  type:         YandexDeviceType;
  custom_data?: Record<string, unknown> | undefined;
  capabilities: CapabilityDefinition[];
  properties:   PropertyDefinition[];
  device_info?: {
    manufacturer?: string | undefined;
    model?:        string | undefined;
    hw_version?:   string | undefined;
    sw_version?:   string | undefined;
  } | undefined;
}

// ─── Discovery response ───────────────────────────────────────────────────────

export interface DevicesDiscoveryResponse {
  request_id: string;
  payload: {
    user_id: string;
    devices: YandexDevice[];
  };
}

// ─── Query request / response ─────────────────────────────────────────────────

export interface QueryRequestDevice {
  id:           string;
  custom_data?: Record<string, unknown>;
}

export interface DevicesQueryRequest {
  devices: QueryRequestDevice[];
}

export interface DeviceQueryResult {
  id:           string;
  capabilities: CapabilityState[];
  properties:   PropertyState[];
  error_code?:  string;
  error_message?: string;
}

export interface DevicesQueryResponse {
  request_id: string;
  payload: {
    devices: DeviceQueryResult[];
  };
}

// ─── Action request / response ────────────────────────────────────────────────

export interface CapabilityActionValue {
  type:  CapabilityType;
  state: CapabilityStateValue;
}

export interface DeviceAction {
  id:           string;
  custom_data?: Record<string, unknown>;
  capabilities: CapabilityActionValue[];
}

export interface DevicesActionRequest {
  payload: {
    devices: DeviceAction[];
  };
}

export interface CapabilityActionResult {
  type:  CapabilityType;
  state: {
    instance:      string;
    action_result: {
      status:        'DONE' | 'ERROR';
      error_code?:   string;
      error_message?: string;
    };
  };
}

export interface DeviceActionResult {
  id:           string;
  capabilities: CapabilityActionResult[];
}

export interface DevicesActionResponse {
  request_id: string;
  payload: {
    devices: DeviceActionResult[];
  };
}

// ─── Unlink ───────────────────────────────────────────────────────────────────

export interface UnlinkResponse {
  request_id: string;
}

// ─── Callback (state change notification → Yandex) ───────────────────────────

export interface DeviceStateChangedCallback {
  ts:      number; // Unix timestamp
  payload: {
    user_id: string;
    devices: Array<{
      id:           string;
      capabilities: CapabilityState[];
      properties:   PropertyState[];
    }>;
  };
}

// ─── OAuth 2.0 (account linking) ─────────────────────────────────────────────

export interface OAuthTokenRequest {
  grant_type:    'authorization_code' | 'refresh_token';
  code?:         string;
  refresh_token?: string;
  client_id:     string;
  client_secret: string;
  redirect_uri?: string;
}

export interface OAuthTokenResponse {
  access_token:  string;
  token_type:    'Bearer';
  expires_in:    number;
  refresh_token: string;
}

export interface OAuthTokenErrorResponse {
  error:              'invalid_grant' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_request';
  error_description?: string | undefined;
}

export interface OAuthAuthorizeParams {
  response_type: 'code';
  client_id:     string;
  redirect_uri:  string;
  state?:        string;
  scope?:        string;
}
