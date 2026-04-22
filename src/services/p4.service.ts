/**
 * @module services/p4.service
 *
 * Internal HTTP client for the P4 Relay service.
 *
 * The P4 Relay is a separate internal microservice that:
 *  - Maintains persistent connections (WebSocket / MQTT over TLS) to each house's P4 board
 *  - Exposes a simple REST API to the alice-adapter
 *  - Translates REST calls → P4 MQTT commands and streams back owner-confirmed results
 *
 * This module owns:
 *  - all outbound HTTP calls to the relay
 *  - timeout enforcement (P4_RELAY_TIMEOUT_MS)
 *  - error normalisation to internal error types
 *  - structured logging of every relay call (without tokens)
 *
 * Architecture rule:
 *  Cloud Proxy NEVER owns device state.
 *  Every state read and write goes through the relay → P4 (owner runtime).
 *
 * Internal relay API contract:
 *  GET  /internal/v1/houses/{house_id}/devices
 *       → P4InventoryResponse
 *
 *  POST /internal/v1/houses/{house_id}/devices/state
 *       body: { device_ids: string[] }
 *       → P4StateResponse
 *
 *  POST /internal/v1/houses/{house_id}/devices/action
 *       body: NormalizedIntent (device_set)
 *       → P4ActionResponse
 */

import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import type {
  NormalizedIntent,
  P4RelayCommandResponse,
  P4RelayStateResponse,
  P4DeviceState,
} from '../types/internal.js';

// ─── P4 inventory types (relay API response) ─────────────────────────────────

export type P4DeviceKind =
  | 'relay'
  | 'dimmer'
  | 'pwm'
  | 'pwm_rgb'
  | 'dali'
  | 'dali_group'
  | 'ds18b20'
  | 'dht_temp'
  | 'dht_humidity'
  | 'adc'
  | 'climate_control'
  | 'aqua_protect'
  | 'curtains'
  | 'script'
  | 'scene';

export interface P4DeviceDescriptor {
  logical_device_id: string;       // stable house-level ID
  kind:              P4DeviceKind;
  name:              string;       // user-configured display name
  room?:             string;       // room name from house config
  online:            boolean;
  board_id:          string;       // owning board
  /**
   * Installer-provided semantics label. Required for ambiguous kinds (relay).
   * Values: 'light' | 'socket' — determines Alice v1 semantic profile.
   * Unrecognised or missing values cause the device to be excluded from
   * discovery (safe default: never expose unclassified relays).
   */
  semantics?:        string;
  // Kind-specific metadata
  meta?: {
    // Dimmer / PWM
    brightness_min?:     number;
    brightness_max?:     number;
    // Climate
    temp_setpoint_min?:  number;
    temp_setpoint_max?:  number;
    // Curtains
    position_min?:       number;
    position_max?:       number;
    // RGB
    supports_color_temp?: boolean;
    color_temp_min_k?:   number;
    color_temp_max_k?:   number;
  };
}

export interface P4InventoryResponse {
  house_id:   string;
  version:    number;          // topology catalog version
  devices:    P4DeviceDescriptor[];
  fetched_at: string;          // ISO 8601
}

export interface P4StateQueryResponse {
  house_id:   string;
  devices:    P4DeviceState[];
  fetched_at: string;
}

// ─── P4RelayError ────────────────────────────────────────────────────────────

export class P4RelayError extends Error {
  constructor(
    public readonly code: 'timeout' | 'house_offline' | 'relay_error' | 'not_found' | 'network_error',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'P4RelayError';
  }
}

// ─── Relay client ─────────────────────────────────────────────────────────────

function relayHeaders(): Record<string, string> {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${env.P4_RELAY_TOKEN}`,
    'Accept':        'application/json',
  };
}

async function relayFetch<T>(
  url: string,
  options: RequestInit,
  log: FastifyBaseLogger,
  requestId: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.P4_RELAY_TIMEOUT_MS);

  const startMs = Date.now();

  try {
    const response = await fetch(url, {
      ...options,
      signal:  controller.signal,
      headers: { ...relayHeaders(), ...options.headers },
    });

    const elapsed = Date.now() - startMs;

    if (!response.ok) {
      // 404 = house_id not found / P4 not connected
      if (response.status === 404) {
        log.warn({ url, status: 404, requestId, elapsed }, 'P4 relay: house not found');
        throw new P4RelayError('not_found', `House not registered in relay`);
      }
      if (response.status === 503) {
        log.warn({ url, status: 503, requestId, elapsed }, 'P4 relay: house offline');
        throw new P4RelayError('house_offline', `P4 is offline for this house`);
      }

      const body = await response.text().catch(() => '');
      log.error({ url, status: response.status, body, requestId, elapsed }, 'P4 relay HTTP error');
      throw new P4RelayError('relay_error', `Relay returned HTTP ${response.status}`);
    }

    log.debug({ url, status: response.status, elapsed, requestId }, 'P4 relay OK');
    return response.json() as Promise<T>;

  } catch (err) {
    if (err instanceof P4RelayError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      log.error({ url, timeout: env.P4_RELAY_TIMEOUT_MS, requestId }, 'P4 relay timeout');
      throw new P4RelayError('timeout', `P4 relay timed out after ${env.P4_RELAY_TIMEOUT_MS}ms`, err);
    }

    log.error({ url, err, requestId }, 'P4 relay network error');
    throw new P4RelayError('network_error', `Network error reaching P4 relay`, err);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the live device inventory for a house from P4.
 *
 * Called on every GET /v1.0/user/devices — no caching per architecture rules.
 * If P4 is offline, throws P4RelayError('house_offline').
 */
export async function fetchP4Inventory(
  houseId: string,
  log: FastifyBaseLogger,
  requestId: string,
): Promise<P4InventoryResponse> {
  const url = `${env.P4_RELAY_URL}/internal/v1/houses/${encodeURIComponent(houseId)}/devices`;

  log.debug({ houseId, requestId }, 'Fetching P4 inventory');

  return relayFetch<P4InventoryResponse>(
    url,
    { method: 'GET' },
    log,
    requestId,
  );
}

/**
 * Query current state of specific devices from P4.
 *
 * Called on every POST /v1.0/user/devices/query.
 * Returns owner-confirmed state — not a cache.
 */
export async function queryP4DeviceState(
  houseId:   string,
  deviceIds: string[],
  log:       FastifyBaseLogger,
  requestId: string,
): Promise<P4StateQueryResponse> {
  const url = `${env.P4_RELAY_URL}/internal/v1/houses/${encodeURIComponent(houseId)}/devices/state`;

  log.debug({ houseId, count: deviceIds.length, requestId }, 'Querying P4 device state');

  return relayFetch<P4StateQueryResponse>(
    url,
    {
      method: 'POST',
      body:   JSON.stringify({ device_ids: deviceIds }),
    },
    log,
    requestId,
  );
}

/**
 * Send a normalized device_set intent to P4 and wait for owner-confirmed result.
 *
 * P4 relay waits for the `command_result` MQTT message from the owner board
 * before responding. The HTTP response reflects the actual hardware outcome.
 */
export async function sendP4DeviceAction(
  intent:    NormalizedIntent,
  log:       FastifyBaseLogger,
  requestId: string,
): Promise<P4RelayCommandResponse> {
  const url = `${env.P4_RELAY_URL}/internal/v1/houses/${encodeURIComponent(intent.house_id)}/devices/action`;

  log.debug(
    { houseId: intent.house_id, deviceId: intent.device_id, type: intent.type, requestId },
    'Sending P4 device action',
  );

  return relayFetch<P4RelayCommandResponse>(
    url,
    {
      method: 'POST',
      body:   JSON.stringify(intent),
    },
    log,
    requestId,
  );
}
