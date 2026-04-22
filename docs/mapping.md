# Device Mapping Reference

## Semantic profile resolution

See `src/semantics/profiles.ts` for the authoritative implementation.

### P4 kind → semantic profile → Yandex type

| P4 Kind         | Semantics label     | Semantic Profile          | Yandex Type                      | Capabilities                                      | Properties              |
|-----------------|---------------------|---------------------------|----------------------------------|---------------------------------------------------|-------------------------|
| `relay`         | `"light"`           | `light.relay`             | `devices.types.light`            | on_off                                            | —                       |
| `relay`         | `"socket"`          | `socket.relay`            | `devices.types.socket`           | on_off                                            | —                       |
| `relay`         | *(none/unknown)*    | —                         | **excluded from v1**             | —                                                 | —                       |
| `switch`        | `"light"`           | `light.relay`             | `devices.types.light`            | on_off                                            | —                       |
| `switch`        | `"socket"`          | `socket.relay`            | `devices.types.socket`           | on_off                                            | —                       |
| `switch`        | *(none/unknown)*    | `light.relay`             | `devices.types.light`            | on_off                                            | —                       |
| `dimmer`        | —                   | `light.dimmer`            | `devices.types.light`            | on_off, range(brightness)                         | —                       |
| `pwm`           | —                   | `light.dimmer`            | `devices.types.light`            | on_off, range(brightness)                         | —                       |
| `pwm_rgb`       | —                   | `light.dimmer`            | `devices.types.light`            | on_off, range(brightness), color_setting(hsv)     | —                       |
| `dali`          | —                   | `light.dimmer`            | `devices.types.light`            | on_off, range(brightness)                         | —                       |
| `dali_group`    | —                   | `light.dimmer`            | `devices.types.light`            | on_off, range(brightness)                         | —                       |
| `curtains`      | —                   | `curtain.cover`           | `devices.types.openable.curtain` | on_off, range(open, position 0–100)               | —                       |
| `climate_control`| —                  | `climate.thermostat.basic`| `devices.types.thermostat`       | on_off, range(temperature setpoint)               | —                       |
| `turkov`        | —                   | `hvac.fan`                | `devices.types.thermostat.ac`    | on_off, mode(fan_speed: auto/low/medium/high/turbo) | —                     |
| `fancoil`       | —                   | `hvac.fan`                | `devices.types.thermostat.ac`    | on_off, mode(fan_speed: auto/low/medium/high/turbo) | —                     |
| `sensords8`     | —                   | `thermostat.floor`        | `devices.types.thermostat`       | on_off, range(temperature setpoint)               | float(temperature)      |
| `aqua_protect`  | —                   | `actuator.valve`          | `devices.types.openable.valve`   | on_off                                            | event(water_leak)       |
| `ds18b20`       | —                   | `sensor.climate.basic`    | `devices.types.sensor.climate`   | —                                                 | float(temperature)      |
| `dht_temp`      | —                   | `sensor.climate.basic`    | `devices.types.sensor.climate`   | —                                                 | float(temperature)      |
| `dht_humidity`  | —                   | `sensor.climate.basic`    | `devices.types.sensor.climate`   | —                                                 | float(humidity)         |
| `adc`           | —                   | `sensor.voltage.basic`    | `devices.types.sensor`           | —                                                 | float(voltage)          |
| `discrete`      | `"motion"`          | `sensor.motion.basic`     | `devices.types.sensor.motion`    | —                                                 | event(motion)           |
| `discrete`      | `"door"`            | `sensor.door.basic`       | `devices.types.sensor.door`      | —                                                 | event(open)             |
| `discrete`      | `"button"`          | `sensor.button.basic`     | `devices.types.sensor.button`    | —                                                 | event(button)           |
| `script`        | —                   | —                         | **excluded from v1**             | —                                                 | —                       |
| `scene`         | —                   | —                         | **excluded from v1**             | —                                                 | —                       |

## Profile capability allowlist

Capabilities allowed for action requests per profile (`PROFILE_ALLOWED_CAPABILITIES`):

| Profile                   | Allowed capability types                              |
|---------------------------|-------------------------------------------------------|
| `light.relay`             | on_off                                                |
| `light.dimmer`            | on_off, range, color_setting                          |
| `socket.relay`            | on_off                                                |
| `curtain.cover`           | on_off, range                                         |
| `climate.thermostat.basic`| on_off, range                                         |
| `sensor.climate.basic`    | *(none — read-only)*                                  |
| `hvac.fan`                | on_off, mode                                          |
| `thermostat.floor`        | on_off, range                                         |
| `actuator.valve`          | on_off                                                |
| `sensor.motion.basic`     | *(none — read-only)*                                  |
| `sensor.door.basic`       | *(none — read-only)*                                  |
| `sensor.button.basic`     | *(none — read-only)*                                  |
| `sensor.voltage.basic`    | *(none — read-only)*                                  |

## Fan speed mode values

`turkov` and `fancoil` use `mode/fan_speed`. The number of available speeds is
specified by `meta.speed_count` in the P4 inventory descriptor.

| Yandex mode value | P4 speed number |
|-------------------|-----------------|
| `auto`            | 0               |
| `low`             | 1               |
| `medium`          | 2               |
| `high`            | 3               |
| `turbo`           | 4               |
| *(max)*           | 5               |

## P4 state property keys

| P4 property key | Value type       | Maps to                                           |
|-----------------|------------------|---------------------------------------------------|
| `on`            | boolean          | capability: on_off → instance=on                  |
| `brightness`    | number 0–100     | capability: range → instance=brightness           |
| `setpoint`      | number °C        | capability: range → instance=temperature          |
| `position`      | number 0–100     | capability: range → instance=open                 |
| `speed`         | number 0–5       | capability: mode → instance=fan_speed             |
| `hue`           | number 0–360     | capability: color_setting → instance=hsv          |
| `saturation`    | number 0–100     | (part of HSV)                                     |
| `value`         | number 0–100     | (part of HSV)                                     |
| `temperature`   | number °C        | property: float → instance=temperature            |
| `humidity`      | number 0–100     | property: float → instance=humidity               |
| `voltage`       | number V         | property: float → instance=voltage                |
| `alarm`         | boolean          | property: event → instance=water_leak (dry/leak)  |
| `motion`        | boolean          | property: event → instance=motion (detected/…)    |
| `open`          | boolean          | property: event → instance=open (opened/closed)   |
| `click`         | string           | property: event → instance=button (click/…)       |

## Device ID format

```
hi:{house_id}:{logical_device_id}

Example: hi:sb-00A3F2:relay-42
```

The `custom_data` returned in discovery contains:
```json
{
  "house_id": "sb-00A3F2",
  "logical_device_id": "relay-42",
  "board_id": "board-01"
}
```

Note: `custom_data` does **not** include `kind`. The server resolves the device
kind and semantic profile from the P4 inventory on every query and action request.

## Action mapping

Yandex capability action → P4 `DeviceSetIntent.property`:

| Capability type                  | Instance        | P4 property   | Value type             |
|----------------------------------|-----------------|---------------|------------------------|
| `devices.capabilities.on_off`    | on              | on            | boolean                |
| `devices.capabilities.range`     | brightness      | brightness    | number 0–100           |
| `devices.capabilities.range`     | temperature     | setpoint      | number °C              |
| `devices.capabilities.range`     | open            | position      | number 0–100           |
| `devices.capabilities.mode`      | fan_speed       | speed         | number 0–5             |
| `devices.capabilities.color_setting` | hsv        | hsv           | {h, s, v}              |
| `devices.capabilities.color_setting` | rgb        | rgb           | number (24-bit)        |
| `devices.capabilities.color_setting` | temperature_k | color_temp_k | number K           |
