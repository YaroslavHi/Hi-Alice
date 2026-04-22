# Device Mapping Reference

## Semantic profile resolution

See `src/semantics/profiles.ts` for the authoritative implementation.

### P4 kind → semantic profile → Yandex type

| P4 Kind        | Semantics label | Semantic Profile          | Yandex Type                    | Capabilities                          |
|----------------|-----------------|---------------------------|--------------------------------|---------------------------------------|
| relay          | "light"         | light.relay               | devices.types.light            | on_off                                |
| relay          | "socket"        | socket.relay              | devices.types.socket           | on_off                                |
| relay          | (none/unknown)  | —                         | **excluded from v1**           | —                                     |
| dimmer         | —               | light.dimmer              | devices.types.light            | on_off, range(brightness)             |
| pwm            | —               | light.dimmer              | devices.types.light            | on_off, range(brightness)             |
| pwm_rgb        | —               | light.dimmer              | devices.types.light            | on_off, range(brightness), color_setting(hsv) |
| dali           | —               | light.dimmer              | devices.types.light            | on_off, range(brightness)             |
| dali_group     | —               | light.dimmer              | devices.types.light            | on_off, range(brightness)             |
| curtains       | —               | curtain.cover             | devices.types.openable.curtain | on_off, range(open, position)         |
| climate_control| —               | climate.thermostat.basic  | devices.types.thermostat       | on_off, range(temperature, setpoint)  |
| ds18b20        | —               | sensor.climate.basic      | devices.types.sensor.climate   | — (properties: temperature)           |
| dht_temp       | —               | sensor.climate.basic      | devices.types.sensor.climate   | — (properties: temperature)           |
| dht_humidity   | —               | sensor.climate.basic      | devices.types.sensor.climate   | — (properties: humidity)              |
| adc            | —               | —                         | **excluded from v1**           | —                                     |
| aqua_protect   | —               | —                         | **excluded from v1**           | —                                     |
| script         | —               | —                         | **excluded from v1**           | —                                     |
| scene          | —               | —                         | **excluded from v1**           | —                                     |

## Profile capability allowlist

Capabilities that are valid for action requests per profile:

| Profile                  | Allowed capability types                                          |
|--------------------------|-------------------------------------------------------------------|
| light.relay              | devices.capabilities.on_off                                       |
| light.dimmer             | devices.capabilities.on_off, range, color_setting                 |
| socket.relay             | devices.capabilities.on_off                                       |
| curtain.cover            | devices.capabilities.on_off, range                                |
| climate.thermostat.basic | devices.capabilities.on_off, range                                |
| sensor.climate.basic     | *(none — read-only)*                                              |

## P4 state property keys

| P4 property key | Value type | Maps to                                  |
|-----------------|------------|------------------------------------------|
| on              | boolean    | capability: on_off → instance=on          |
| brightness      | number 0–100 | capability: range → instance=brightness  |
| setpoint        | number °C  | capability: range → instance=temperature  |
| position        | number 0–100 | capability: range → instance=open       |
| hue             | number 0–360 | capability: color_setting → instance=hsv |
| saturation      | number 0–100 | (part of HSV)                            |
| value           | number 0–100 | (part of HSV)                            |
| temperature     | number °C  | property: float → instance=temperature    |
| humidity        | number 0–100 | property: float → instance=humidity      |

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

| Capability type              | Instance      | P4 property   | Value type             |
|------------------------------|---------------|---------------|------------------------|
| devices.capabilities.on_off  | on            | on            | boolean                |
| devices.capabilities.range   | brightness    | brightness    | number 0–100           |
| devices.capabilities.range   | temperature   | setpoint      | number °C              |
| devices.capabilities.range   | open          | position      | number 0–100           |
| devices.capabilities.color_setting | hsv     | hsv           | {h, s, v}              |
| devices.capabilities.color_setting | rgb     | rgb           | number (24-bit)        |
| devices.capabilities.color_setting | temperature_k | color_temp_k | number K            |
