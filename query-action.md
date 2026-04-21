# A4 — Query & Action

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1.0/user/devices/query` | Read current device state from P4 |
| `POST` | `/v1.0/user/devices/action` | Execute command; wait for P4 owner confirmation |

## Core Rule

> All state MUST come from P4 (owner-confirmed). Cloud never guesses or caches state.

## Query Flow

```
Yandex            alice-adapter          P4 Relay            P4
  │                    │                     │                 │
  │─ POST /query ─────▶│                     │                 │
  │  { devices:[{id}] }│                     │                 │
  │                    │─ extract HMAC(token)│                 │
  │                    │  → ValidatedLink    │                 │
  │                    │                     │                 │
  │                    │─ POST /state ──────▶│                 │
  │                    │  { device_ids }     │                 │
  │                    │                     │─ MQTT request──▶│
  │                    │                     │  sb/{h}/device/ │
  │                    │                     │  {id}/state     │
  │                    │                     │◀─ retained ─────│
  │                    │◀─ P4StateResponse ──│                 │
  │                    │                     │                 │
  │                    │─ mapP4StateToYandex()               │
  │◀─ 200 { devices }──│                     │                 │
```

## Action Flow

```
Yandex            alice-adapter          P4 Relay            P4 + STM32
  │                    │                     │                 │
  │─ POST /action ────▶│                     │                 │
  │  { payload:{       │                     │                 │
  │    devices:[{      │                     │                 │
  │      id, caps }]}} │                     │                 │
  │                    │─ mapCapabilityAction()              │
  │                    │  → DeviceSetIntent  │                 │
  │                    │                     │                 │
  │                    │─ POST /action ─────▶│                 │
  │                    │                     │─ MQTT publish──▶│
  │                    │                     │  sb/{h}/device/ │
  │                    │                     │  {id}/set       │
  │                    │                     │                 │── SQI → STM32
  │                    │                     │                 │   hardware cmd
  │                    │                     │                 │◀── SQI result
  │                    │                     │◀─ MQTT ─────────│
  │                    │                     │  command_result  │
  │                    │◀─ { status: "ok" }──│                 │
  │                    │                     │                 │
  │◀─ 200 DONE ────────│                     │                 │
```

**NEVER returns DONE speculatively.** The relay blocks until P4 publishes `command_result`.

## Capability → P4 Property Mapping

| Yandex capability | Instance | P4 property | Notes |
|------------------|----------|-------------|-------|
| `on_off` | `on` | `on` (boolean) | |
| `range` | `brightness` | `brightness` (0–100) | |
| `range` | `temperature` | `setpoint` (°C) | |
| `range` | `open` | `position` (0–100) | |
| `color_setting` | `hsv` | `hsv` ({h,s,v}) | |
| `color_setting` | `rgb` | `rgb` (int) | |
| `color_setting` | `temperature_k` | `color_temp_k` (K) | |

Relative range values (`relative: true`) are passed to P4 — P4 computes absolute from current state.

## Concurrency

- Multiple **devices** in one request → `Promise.allSettled()` (parallel)
- Multiple **capabilities** on one device → sequential (order preserved)

## Per-Device Error Codes

| Scenario | error_code |
|----------|-----------|
| Device ID unparseable | `DEVICE_NOT_FOUND` |
| house_id mismatch (token scope) | `DEVICE_NOT_FOUND` |
| P4 relay timeout | `DEVICE_UNREACHABLE` |
| P4 reports device_not_found | `DEVICE_NOT_FOUND` |
| P4 reports timeout | `DEVICE_UNREACHABLE` |
| P4 reports rejected | `NOT_SUPPORTED_IN_CURRENT_MODE` |
| Device online=false in P4 | `DEVICE_UNREACHABLE` |

All device-level failures return **HTTP 200**. Per Yandex spec, errors go in `action_result.error_code`.
