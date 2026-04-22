# HI Alice Adapter — Architecture

## Overview

This service is the Cloud Control Plane boundary between Yandex Smart Home (Alice)
and the HI SmartBox owner runtime (P4). It implements the
[Yandex Smart Home REST API](https://yandex.ru/dev/dialogs/smart-home/doc/en/reference/).

## Core principle: P4 is the only owner of state

The cloud adapter is a **pure relay**:

- Never stores device state.
- Never returns speculative results before P4 confirms hardware execution.
- Every state read goes through P4 relay (owner-confirmed, not a cache).
- Every action waits for the MQTT `command_result` from the P4 board.

## System diagram

```
Yandex Alice
     │
     │  REST (Yandex Smart Home API)
     ▼
alice-adapter (this service)
     │  OAuth, Discovery, Query, Action, Notifications
     │
     │  REST (internal relay API)
     ▼
P4 Relay (internal microservice)
     │
     │  MQTT / WebSocket / TLS
     ▼
ESP32-P4 Board (authoritative device state)
```

## Semantic profile system

### Why profiles, not raw P4 kinds

A raw `relay` hardware kind can represent a light switch or a power socket.
The Yandex Smart Home type (`devices.types.light` vs `devices.types.socket`)
must be determined from **user semantics**, not hardware kind.

### Resolution chain

```
P4DeviceDescriptor.kind + .semantics
           │
    resolveSemanticProfile()           (src/semantics/profiles.ts)
           │
    SemanticProfileId | null
           │
    V1_ALLOWED_PROFILES check          (compatibility allowlist)
           │
    PROFILE_YANDEX_TYPE lookup         (device.mapper.ts)
           │
    YandexDeviceType
```

### Approved v1 semantic profiles

| Profile                  | Input (kind + semantics)           | Yandex Type                    |
|--------------------------|------------------------------------|--------------------------------|
| `light.relay`            | relay + semantics="light"          | `devices.types.light`          |
| `light.dimmer`           | dimmer / pwm / pwm_rgb / dali / dali_group | `devices.types.light`  |
| `socket.relay`           | relay + semantics="socket"         | `devices.types.socket`         |
| `curtain.cover`          | curtains                           | `devices.types.openable.curtain` |
| `climate.thermostat.basic` | climate_control                  | `devices.types.thermostat`     |
| `sensor.climate.basic`   | ds18b20 / dht_temp / dht_humidity  | `devices.types.sensor.climate` |

### Excluded from v1

The following P4 kinds are never discoverable in v1:
- `relay` without `semantics` label (ambiguous)
- `adc` — voltage sensor (no approved v1 profile)
- `aqua_protect` — water valve (no approved v1 profile)
- `script`, `scene` — automation triggers

## Query: server-side semantic resolution

**DEFECT B fix**: the query controller never relies on `custom_data.kind` from the
Yandex request. Instead:

1. Fetch P4 inventory to get authoritative device descriptors (kind + semantics).
2. Resolve semantic profile server-side.
3. Devices with no approved v1 profile return `DEVICE_NOT_FOUND`.
4. Query P4 state using kind from inventory.

This prevents a Yandex request from influencing the server's type decision.

## Action: profile-level capability validation

Before forwarding an action to P4, the action controller:

1. Fetches P4 inventory to resolve the device's semantic profile.
2. Checks the capability type against `PROFILE_ALLOWED_CAPABILITIES[profile]`.
3. Rejects unsupported capabilities with `NOT_SUPPORTED_IN_CURRENT_MODE`
   without sending to P4.

This is defence-in-depth: P4 would also reject invalid actions, but the
adapter validates earlier and with a clearer error.

## Token security model

```
At-rest:   AES-256-GCM(rawToken)  → access_token_encrypted
Lookup:    HMAC-SHA256(rawToken)   → access_token_hmac (UNIQUE INDEX)

Validation path (per Yandex API request):
  L1: Redis cache  GET alice:link:{hmac}  → ~1ms
  L2: DB HMAC lookup  WHERE access_token_hmac = $hmac  → ~5ms
  No argon2 on the hot path.

Unlink: hard-deletes Redis cache key (immediate invalidation).
```

## Database schema

Three tables in PostgreSQL:

| Table               | Purpose                                     |
|---------------------|---------------------------------------------|
| `oauth_auth_codes`  | 10-min single-use auth codes (HMAC indexed) |
| `alice_account_links` | One active link per house; access+refresh tokens |
| `alice_audit_log`   | Append-only audit log                        |

## Redis key schema

| Key pattern                         | TTL      | Purpose                          |
|-------------------------------------|----------|----------------------------------|
| `alice:link:{hmac}`                 | ≤5 min   | Token validation L1 cache        |
| `alice:authcode:meta:{codeHmac}`    | 10 min   | Yandex user_id during OAuth      |
| `alice:notif:queue`                 | —        | Notification delivery queue      |
| `alice:notif:dedup:{kind}:{user}:{device}` | 30s | Notification deduplication  |
