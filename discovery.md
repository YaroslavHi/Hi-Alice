# A3 — Device Discovery

## Endpoint

`GET /v1.0/user/devices`  
Authentication: `Authorization: Bearer {access_token}`

## Architecture Rule

> "Cloud Proxy syncs device list with P4 on every GET /devices — no local copy."

Every discovery request fetches live inventory from P4 relay. Zero caching of device list.

## Supported Device Profiles (Allowlist)

Only these P4 device kinds are exposed to Yandex. Any other kind is silently filtered.

| P4 kind | Yandex type | Capabilities | Properties |
|---------|-------------|--------------|------------|
| `relay` | `devices.types.switch` | `on_off` | — |
| `dimmer` | `devices.types.light` | `on_off`, `range(brightness)` | — |
| `pwm` | `devices.types.light` | `on_off`, `range(brightness)` | — |
| `pwm_rgb` | `devices.types.light` | `on_off`, `range(brightness)`, `color_setting(hsv)` | — |
| `dali` | `devices.types.light` | `on_off`, `range(brightness)` | — |
| `dali_group` | `devices.types.light` | `on_off`, `range(brightness)` | — |
| `ds18b20` | `devices.types.sensor` | — | `float(temperature)` |
| `dht_temp` | `devices.types.sensor` | — | `float(temperature)` |
| `dht_humidity` | `devices.types.sensor` | — | `float(humidity)` |
| `adc` | `devices.types.sensor` | — | `float(voltage)` |
| `climate_control` | `devices.types.thermostat` | `on_off`, `range(temperature)` | — |
| `aqua_protect` | `devices.types.openable` | `on_off` | — |
| `curtains` | `devices.types.openable.curtain` | `on_off`, `range(open)` | — |
| `script` | `devices.types.other` | `on_off` (write-only) | — |
| `scene` | `devices.types.other` | `on_off` (write-only) | — |

## Device ID Format

```
hi:{hi_house_id}:{logical_device_id}
```

- **Stable**: logical_device_id is provisioned at setup, never changes
- **Opaque to Yandex**: Yandex stores and echoes it back verbatim
- **Parseable**: split on first two `:` → house + device

## Custom Data Payload

Each device carries `custom_data` that Yandex echoes back in query/action requests:

```json
{
  "custom_data": {
    "house_id":          "sb-00A3F2",
    "logical_device_id": "relay-42",
    "board_id":          "board-01",
    "kind":              "relay"
  }
}
```

The `kind` field lets the query endpoint map P4 state without a second inventory fetch.

## Offline Behaviour

| P4 Relay status | HTTP response |
|----------------|---------------|
| `house_offline` | 200 + empty device list |
| `timeout` | 200 + empty device list |
| `relay_error` | 500 |

Returning empty list (not 5xx) means Yandex shows devices as unavailable rather than reporting a skill error.

## Example Response

```json
{
  "request_id": "abc-123",
  "payload": {
    "user_id": "yandex-uid-999",
    "devices": [
      {
        "id": "hi:sb-00A3F2:relay-42",
        "name": "Living Room Light",
        "type": "devices.types.switch",
        "room": "Living Room",
        "capabilities": [
          { "type": "devices.capabilities.on_off", "retrievable": true, "reportable": true, "parameters": { "split": false } }
        ],
        "properties": [],
        "device_info": { "manufacturer": "HI SmartBox", "model": "relay" },
        "custom_data": { "house_id": "sb-00A3F2", "logical_device_id": "relay-42", "board_id": "board-01" }
      }
    ]
  }
}
```
