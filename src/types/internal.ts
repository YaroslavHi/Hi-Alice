/**
 * @module types/internal
 *
 * Internal domain types for the Alice adapter.
 * These are NOT Yandex API types — they belong to HI SmartBox domain.
 */

// ─── Token domain ─────────────────────────────────────────────────────────────

// Note: postgres client uses `transform: postgres.camel` so column names
// arrive as camelCase from the DB driver.
export interface StoredAccessToken {
  id:            string;
  tokenHash:     string;
  userId:        string;
  houseId:       string;
  yandexUserId:  string;
  scope:         string;
  expiresAt:     Date;
  revokedAt?:    Date | null;
  createdAt:     Date;
}

export interface StoredRefreshToken {
  id:             string;
  tokenHash:      string;
  accessTokenId:  string;
  userId:         string;
  expiresAt:      Date;
  usedAt?:        Date | null;
  revokedAt?:     Date | null;
  createdAt:      Date;
}

export interface StoredAuthCode {
  id:           string;
  codeHash:     string;
  clientId:     string;
  userId:       string;
  houseId:      string;
  yandexUserId: string;
  redirectUri:  string;
  scope:        string;
  expiresAt:    Date;
  usedAt?:      Date | null;
  createdAt:    Date;
}

// ─── Account linking ─────────────────────────────────────────────────────────

export interface AliceAccountLink {
  id:             string;
  user_id:        string;
  house_id:       string;
  yandex_user_id: string;
  linked_at:      Date;
  unlinked_at?:   Date | null;
  access_token_id: string;
}

// ─── Validated token payload (decoded, not raw string) ────────────────────────

export interface ValidatedToken {
  access_token_id:   string;
  access_token_hmac: string;   // HMAC stored for immediate cache invalidation on unlink
  user_id:           string;
  house_id:          string;
  yandex_user_id:    string;
  scope:             string;
  expires_at:        Date;
}

// ─── Request context (attached to Fastify request after auth) ─────────────────

declare module 'fastify' {
  interface FastifyRequest {
    tokenContext?: ValidatedToken;
    requestId:     string;
  }
}

// ─── Normalized intents (sent to P4 relay) ───────────────────────────────────
// These match the intent contract defined in CLOUD.md

export type NormalizedIntentType =
  | 'device_set'
  | 'device_get'
  | 'scene_run'
  | 'script_run'
  | 'group_action'
  | 'house_mode_change'
  | 'clarification_required'
  | 'unsupported_request';

export interface DeviceSetIntent {
  type:     'device_set';
  house_id: string;
  device_id: string;           // logical_device_id (without hi: prefix)
  property: string;
  value:    boolean | number | string | Record<string, unknown>;
  relative?: boolean | undefined;
  request_id: string;
}

export interface DeviceGetIntent {
  type:     'device_get';
  house_id: string;
  device_id: string;
  request_id: string;
}

export type NormalizedIntent = DeviceSetIntent | DeviceGetIntent;

// ─── P4 Relay response ────────────────────────────────────────────────────────

export interface P4RelayCommandResponse {
  request_id:  string;
  house_id:    string;
  device_id:   string;
  status:      'ok' | 'timeout' | 'device_not_found' | 'error' | 'rejected';
  error_code?: string;
  error_message?: string;
}

export interface P4RelayStateResponse {
  request_id:  string;
  house_id:    string;
  device_id:   string;
  status:      'ok' | 'timeout' | 'device_not_found' | 'error';
  state?:      P4DeviceState;
}

// ─── P4 Device state snapshot ─────────────────────────────────────────────────

export interface P4DeviceProperty {
  key:   string;
  value: boolean | number | string | null;
  updated_at: string; // ISO 8601
}

export interface P4DeviceState {
  logical_device_id: string;
  online:            boolean;
  properties:        P4DeviceProperty[];
}

// ─── Error codes ──────────────────────────────────────────────────────────────

export const ALICE_ERROR_CODES = {
  DEVICE_NOT_FOUND:         'DEVICE_NOT_FOUND',
  DEVICE_UNREACHABLE:       'DEVICE_UNREACHABLE',
  INVALID_VALUE:            'INVALID_VALUE',
  NOT_SUPPORTED_IN_CURRENT_MODE: 'NOT_SUPPORTED_IN_CURRENT_MODE',
  INTERNAL_ERROR:           'INTERNAL_ERROR',
  INVALID_ACTION:           'INVALID_ACTION',
  DEVICE_BUSY:              'DEVICE_BUSY',
  DEVICE_OFF:               'DEVICE_OFF',
  REMOTE_CONTROL_DISABLED:  'REMOTE_CONTROL_DISABLED',
} as const;

export type AliceErrorCode = typeof ALICE_ERROR_CODES[keyof typeof ALICE_ERROR_CODES];

// ─── House & Device records (DB rows) ────────────────────────────────────────

// postgres.camel transform is active → all DB row fields arrive as camelCase.
export interface HouseRecord {
  houseId:           string;
  displayName:       string;
  ownerLogin:        string;
  mqttBrokerUrl:     string;
  mqttUsername:      string | null;
  mqttTopicPrefix:   string;
  active:            boolean;
  createdAt:         Date;
  updatedAt:         Date;
}

export interface DeviceRecord {
  houseId:           string;
  logicalDeviceId:   string;
  kind:              string;
  semantics:         string | null;
  name:              string;
  room:              string;
  boardId:           string | null;
  meta:              Record<string, unknown> | null;
  enabled:           boolean;
  sortOrder:         number;
  createdAt:         Date;
  updatedAt:         Date;
}

export interface DeviceUpsert {
  logical_device_id:  string;
  kind:               string;
  semantics?:         string;
  name:               string;
  room:               string;
  board_id?:          string;
  meta?:              Record<string, unknown>;
  enabled?:           boolean;
  sort_order?:        number;
}

export interface HouseCreate {
  house_id:           string;
  display_name:       string;
  owner_login:        string;
  owner_password:     string;   // plaintext — hashed in service layer
  mqtt_broker_url:    string;
  mqtt_username?:     string;
  mqtt_password?:     string;   // plaintext — encrypted in service layer
  mqtt_topic_prefix?: string;
}
