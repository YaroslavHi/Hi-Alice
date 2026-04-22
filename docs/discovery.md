# Discovery — GET /v1.0/user/devices

## Endpoint

`GET /v1.0/user/devices`  
Authentication: `Authorization: Bearer {access_token}`

## Architecture Rule

Every discovery request fetches live inventory from P4 relay. Zero caching of device list.

## Semantic profile resolution

Device type is resolved via a three-layer chain — **never** from raw hardware kind alone:

```
P4DeviceDescriptor.kind + .semantics
         │
  resolveSemanticProfile()   (src/semantics/profiles.ts)
         │
  SemanticProfileId | null
         │
  V1_ALLOWED_PROFILES check
         │
  PROFILE_YANDEX_TYPE lookup (src/mappers/device.mapper.ts)
         │
  YandexDeviceType
```

Devices that resolve to `null` (no approved v1 profile) are **silently filtered** — never returned to Yandex.

## Approved v1 profiles

| P4 kind          | semantics       | Semantic Profile           | Yandex Type                      | Capabilities                               | Properties          |
|------------------|-----------------|----------------------------|----------------------------------|--------------------------------------------|---------------------|
| `relay`          | `"light"`       | `light.relay`              | `devices.types.light`            | `on_off`                                   | —                   |
| `relay`          | `"socket"`      | `socket.relay`             | `devices.types.socket`           | `on_off`                                   | —                   |
| `relay`          | *(none)*        | —                          | **excluded**                     | —                                          | —                   |
| `switch`         | `"light"`       | `light.relay`              | `devices.types.light`            | `on_off`                                   | —                   |
| `switch`         | `"socket"`      | `socket.relay`             | `devices.types.socket`           | `on_off`                                   | —                   |
| `switch`         | *(none)*        | `light.relay`              | `devices.types.light`            | `on_off`                                   | —                   |
| `dimmer`         | —               | `light.dimmer`             | `devices.types.light`            | `on_off`, `range(brightness)`              | —                   |
| `pwm`            | —               | `light.dimmer`             | `devices.types.light`            | `on_off`, `range(brightness)`              | —                   |
| `pwm_rgb`        | —               | `light.dimmer`             | `devices.types.light`            | `on_off`, `range(brightness)`, `color_setting(hsv)` | —        |
| `dali`           | —               | `light.dimmer`             | `devices.types.light`            | `on_off`, `range(brightness)`              | —                   |
| `dali_group`     | —               | `light.dimmer`             | `devices.types.light`            | `on_off`, `range(brightness)`              | —                   |
| `curtains`       | —               | `curtain.cover`            | `devices.types.openable.curtain` | `on_off`, `range(open)`                    | —                   |
| `climate_control`| —               | `climate.thermostat.basic` | `devices.types.thermostat`       | `on_off`, `range(temperature)`             | —                   |
| `turkov`         | —               | `hvac.fan`                 | `devices.types.thermostat.ac`    | `on_off`, `mode(fan_speed)`                | —                   |
| `fancoil`        | —               | `hvac.fan`                 | `devices.types.thermostat.ac`    | `on_off`, `mode(fan_speed)`                | —                   |
| `sensords8`      | —               | `thermostat.floor`         | `devices.types.thermostat`       | `on_off`, `range(temperature)`             | `float(temperature)`|
| `aqua_protect`   | —               | `actuator.valve`           | `devices.types.openable.valve`   | `on_off`                                   | `event(water_leak)` |
| `ds18b20`        | —               | `sensor.climate.basic`     | `devices.types.sensor.climate`   | —                                          | `float(temperature)`|
| `dht_temp`       | —               | `sensor.climate.basic`     | `devices.types.sensor.climate`   | —                                          | `float(temperature)`|
| `dht_humidity`   | —               | `sensor.climate.basic`     | `devices.types.sensor.climate`   | —                                          | `float(humidity)`   |
| `adc`            | —               | `sensor.voltage.basic`     | `devices.types.sensor`           | —                                          | `float(voltage)`    |
| `discrete`       | `"motion"`      | `sensor.motion.basic`      | `devices.types.sensor.motion`    | —                                          | `event(motion)`     |
| `discrete`       | `"door"`        | `sensor.door.basic`        | `devices.types.sensor.door`      | —                                          | `event(open)`       |
| `discrete`       | `"button"`      | `sensor.button.basic`      | `devices.types.sensor.button`    | —                                          | `event(button)`     |
| `script`         | —               | —                          | **excluded**                     | —                                          | —                   |
| `scene`          | —               | —                          | **excluded**                     | —                                          | —                   |

## Device ID format

```
hi:{house_id}:{logical_device_id}
```

Stable: `logical_device_id` is provisioned at setup and never changes. Yandex stores and echoes it back verbatim in query/action requests.

## custom_data

Each device carries `custom_data` that Yandex echoes back on query/action:

```json
{
  "custom_data": {
    "house_id":          "sb-00A3F2",
    "logical_device_id": "relay-42",
    "board_id":          "board-01"
  }
}
```

`kind` is **not** included in `custom_data`. The server resolves kind and semantic profile from P4 inventory on every query and action request (never trusts Yandex-controlled fields for type decisions).

## Offline behaviour

| P4 relay status | HTTP response                       |
|-----------------|-------------------------------------|
| `house_offline` | 200 + empty device list             |
| `timeout`       | 200 + empty device list             |
| `relay_error`   | 500                                 |

Returning an empty list (not 5xx) means Yandex shows devices as unavailable rather than reporting a skill error.

## Example response

```json
{
  "request_id": "abc-123",
  "payload": {
    "user_id": "yandex-uid-999",
    "devices": [
      {
        "id": "hi:sb-00A3F2:relay-42",
        "name": "Люстра в гостиной",
        "type": "devices.types.light",
        "room": "Гостиная",
        "capabilities": [
          {
            "type": "devices.capabilities.on_off",
            "retrievable": true,
            "reportable": true,
            "parameters": { "split": false }
          }
        ],
        "properties": [],
        "device_info": { "manufacturer": "HI SmartBox", "model": "relay" },
        "custom_data": {
          "house_id": "sb-00A3F2",
          "logical_device_id": "relay-42",
          "board_id": "board-01"
        }
      }
    ]
  }
}
```
