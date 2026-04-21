# Stages A3–A8 — Discovery, Query, Action, Relay, Notifications

---

## Stage A3 — Device Discovery

**Endpoint:** `GET /v1.0/user/devices`

### Architecture

```
Yandex              alice-adapter           P4 Relay              P4 Board
   │                     │                     │                      │
   │─ GET /v1.0/user/devices                   │                      │
   │  Authorization: Bearer {token}            │                      │
   │                     │                     │                      │
   │            validateBearerToken            │                      │
   │            (Redis → DB → argon2)          │                      │
   │                     │                     │                      │
   │                     │─ GET /internal/v1/houses/{house_id}/devices│
   │                     │                     │                      │
   │                     │                     │─ MQTT subscribe ─────│
   │                     │                     │  sb/{house_id}/      │
   │                     │                     │  board/+/topology_   │
   │                     │                     │  snapshot            │
   │                     │                     │◀─ inventory ─────────│
   │                     │◀─ P4InventoryResponse                      │
   │                     │                     │                      │
   │            mapP4InventoryToYandex         │                      │
   │            (filter unsupported kinds)     │                      │
   │                     │                     │                      │
   │◀─ 200 { request_id, payload.devices } ───│                      │
```

### Key Rules
- **No cache** — every discovery call fetches live from P4 (per CLOUD.md architecture rule)
- **Offline graceful** — if P4 is offline, returns HTTP 200 with empty device list
- **Kind filtering** — `KIND_MAP` in `device.mapper.ts` is the whitelist; unmapped kinds silently dropped, logged at DEBUG

### Device ID Format
```
hi:{house_id}:{logical_device_id}
```
Yandex stores this and echoes it back in every action/query request.
`custom_data` carries `{ house_id, logical_device_id, board_id, kind }` for fast parsing.

---

## Stage A4 — Device State Query

**Endpoint:** `POST /v1.0/user/devices/query`

### Architecture

```
Yandex              alice-adapter           P4 Relay              P4
   │                     │                     │                   │
   │─ POST /v1.0/user/devices/query            │                   │
   │  body: { devices: [{ id, custom_data }] } │                   │
   │                     │                     │                   │
   │            parse + validate IDs          │                   │
   │            check house_id == token scope  │                   │
   │                     │                     │                   │
   │                     │─ POST /internal/v1/houses/{id}/devices/state
   │                     │  body: { device_ids: [...] }            │
   │                     │                     │                   │
   │                     │                     │─ MQTT request ────│
   │                     │                     │  sb/{h}/device/   │
   │                     │                     │  {id}/state       │
   │                     │                     │◀─ retained state ─│
   │                     │◀─ P4StateQueryResponse                  │
   │                     │                     │                   │
   │            mapP4StateToYandex(kind, state)│                   │
   │                     │                     │                   │
   │◀─ 200 { payload.devices: [{              │                   │
   │         id, capabilities, properties }] } │                   │
```

### Per-Device Error Handling
| Scenario | Response |
|----------|----------|
| Device ID unparseable | `error_code: DEVICE_NOT_FOUND` |
| `house_id` mismatch | `error_code: DEVICE_NOT_FOUND` (no leakage) |
| P4 relay timeout | `error_code: DEVICE_UNREACHABLE` for all |
| Device not in P4 response | `error_code: DEVICE_NOT_FOUND` |
| Device `online: false` | `error_code: DEVICE_UNREACHABLE` |
| Kind missing from `custom_data` | `error_code: DEVICE_UNREACHABLE` |
| Success | full `capabilities` + `properties` |

**Always returns HTTP 200.** Per Yandex spec, device-level errors go in the per-device `error_code` field.

### State Property Keys (P4 → Yandex mapping)
| P4 key | Yandex capability/property |
|--------|---------------------------|
| `on` (boolean) | `on_off` → `instance: on` |
| `brightness` (0–100) | `range` → `instance: brightness` |
| `setpoint` (°C) | `range` → `instance: temperature` |
| `position` (0–100) | `range` → `instance: open` |
| `hue/saturation/value` | `color_setting` → `instance: hsv` |
| `temperature` | `float` property → `instance: temperature` |
| `humidity` | `float` property → `instance: humidity` |
| `voltage` | `float` property → `instance: voltage` |

---

## Stage A6 — Device Action

**Endpoint:** `POST /v1.0/user/devices/action`

### Architecture

```
Yandex              alice-adapter           P4 Relay              P4
   │                     │                     │                   │
   │─ POST /v1.0/user/devices/action           │                   │
   │  body: { payload: { devices: [           │                   │
   │    { id, capabilities: [                 │                   │
   │      { type, state: { instance, value } }│                   │
   │    ]} ]} }                               │                   │
   │                     │                     │                   │
   │         ┌─ device 1 ─────────────────────────────────────────│
   │         │   mapCapabilityAction()         │                   │
   │         │   → ActionMappingResult         │                   │
   │         │   buildDeviceSetIntent()        │                   │
   │         │                     │─ POST /internal/.../action    │
   │         │                     │  body: DeviceSetIntent        │
   │         │                     │                     │         │
   │         │                     │                     │─ MQTT publish
   │         │                     │                     │  sb/{h}/device/{id}/set
   │         │                     │                     │         │
   │         │                     │                     │◀─ command_result (owner-confirmed)
   │         │                     │◀─ P4RelayCommandResponse      │
   │         │                     │                     │         │
   │         └─ device 2 ... (parallel per device, sequential per capability)
   │                     │                     │                   │
   │◀─ 200 { payload: { devices: [            │                   │
   │   { id, capabilities: [                  │                   │
   │     { type, state: { instance,           │                   │
   │       action_result: { status: DONE }}}  │                   │
   │   ]}]}}                                  │                   │
```

### Concurrency Model
```
Request: [device_A, device_B, device_C]
                         │
              Promise.allSettled()
              ┌───────────┬───────────┐
         device_A    device_B    device_C   ← parallel
              │            │           │
         [cap1, cap2] [cap1]    [cap1, cap2, cap3]
              │            │           │
          sequential   sequential  sequential  ← caps within device
```

### P4 Command Lifecycle
```
alice-adapter → relay:  POST /action { type: "device_set", house_id, device_id, property, value }
relay → P4 MQTT:        PUBLISH sb/{h}/device/{id}/set { property, value, request_id }
P4 board:               executes hardware command → STM32 SQI
P4 MQTT → relay:        PUBLISH sb/{h}/device/{id}/command_result { status: "ok"|"error" }
relay → alice-adapter:  HTTP response { status: "ok" }
alice-adapter → Yandex: { action_result: { status: "DONE" } }
```

**NEVER returns DONE speculatively.** Only after P4 owner-confirms the hardware action.

### Action Mapping Table
| Yandex capability | Instance | P4 intent |
|------------------|----------|-----------|
| `on_off` | `on` | `{ property: "on", value: boolean }` |
| `range` | `brightness` | `{ property: "brightness", value: 0–100 }` |
| `range` | `temperature` | `{ property: "setpoint", value: °C }` |
| `range` | `open` | `{ property: "position", value: 0–100 }` |
| `color_setting` | `hsv` | `{ property: "hsv", value: {h,s,v} }` |
| `color_setting` | `rgb` | `{ property: "rgb", value: number }` |
| `color_setting` | `temperature_k` | `{ property: "color_temp_k", value: K }` |

### Relative Values
`range` capabilities may arrive with `relative: true` (e.g. "make brighter by 10%").
The `relative` flag is passed through in the `DeviceSetIntent` to P4.
P4 is responsible for computing absolute value from current device state.

---

## Stage A7 — P4 Relay Service

**Module:** `src/services/p4.service.ts`

The relay service is an **internal microservice** (not part of this repo — deployed separately).
This module is the HTTP client that calls it.

### Internal Relay REST API Contract

```
GET  /internal/v1/houses/{house_id}/devices
     → P4InventoryResponse { house_id, version, devices[], fetched_at }

POST /internal/v1/houses/{house_id}/devices/state
     body: { device_ids: string[] }
     → P4StateQueryResponse { house_id, devices[], fetched_at }

POST /internal/v1/houses/{house_id}/devices/action
     body: NormalizedIntent (DeviceSetIntent)
     → P4RelayCommandResponse { request_id, house_id, device_id, status }

Auth: Authorization: Bearer {P4_RELAY_TOKEN}
```

### Error Codes
| HTTP | P4RelayError.code | Meaning |
|------|-------------------|---------|
| 404 | `not_found` | house_id not registered in relay |
| 503 | `house_offline` | P4 board unreachable |
| AbortError | `timeout` | exceeded P4_RELAY_TIMEOUT_MS |
| network | `network_error` | relay unreachable |
| 5xx | `relay_error` | relay internal error |

### Timeout Budget
Default `P4_RELAY_TIMEOUT_MS = 8000ms`.

The relay itself should complete in:
- Device inventory: < 2s (cached topology + fresh online status)
- State query: < 3s (MQTT request-response cycle)
- Action: < 6s (hardware command + STM32 execution + MQTT confirmation)

---

## Stage A8 — State Change Notifications

**Internal webhook:** `POST /internal/p4/state-change`  
**Outbound:** Yandex callback API `POST https://dialogs.yandex.net/api/v1/skills/{skill_id}/callback/state`

### Architecture

```
P4 Board            P4 Relay           alice-adapter        Yandex
    │                   │                    │                  │
    │─ MQTT publish ───▶│                    │                  │
    │  sb/{h}/device/   │                    │                  │
    │  {id}/state       │                    │                  │
    │  (retained)       │                    │                  │
    │                   │─ POST /internal/p4/state-change       │
    │                   │  { house_id, yandex_user_id,          │
    │                   │    logical_device_id, kind,           │
    │                   │    online, properties }               │
    │                   │                    │                  │
    │                   │         202 Accepted                  │
    │                   │                    │                  │
    │                   │         ┌─ background task ──────────▶│
    │                   │         │  mapP4StateToYandex()        │
    │                   │         │  POST callback/state         │
    │                   │         │  (retry ×3, backoff)         │
    │                   │         │                    │         │
    │                   │         │          ◀─ 200 OK ─────────│
```

### Retry Policy
```
Attempt 1: immediate
Attempt 2: +1s delay
Attempt 3: +2s delay (total max ~3s of retries)
429 response: respects Retry-After header
4xx client error: aborts immediately (no retry)
```

### Security
- Internal endpoint authenticated with `P4_RELAY_TOKEN`
- Not exposed to Yandex (internal network only)
- Relay must provide `yandex_user_id` (looked up from `alice_account_links` by relay)

### Notification Payload (Yandex format)
```json
{
  "ts": 1712234567,
  "payload": {
    "user_id": "yandex_uid_123",
    "devices": [
      {
        "id": "hi:sb-00A3F2:relay-42",
        "capabilities": [
          {
            "type": "devices.capabilities.on_off",
            "state": { "instance": "on", "value": true },
            "last_updated": 1712234567
          }
        ],
        "properties": []
      }
    ]
  }
}
```
