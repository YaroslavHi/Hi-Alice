# A6 — Compatibility Layer

## Core Rule

> Explicit allowlist only. If a device kind is not in the allowlist, it is never exposed to Yandex.

## Allowlist Location

`src/mappers/device.mapper.ts` → `KIND_MAP`

```typescript
const KIND_MAP: Record<string, KindMapping> = {
  relay:           { type: 'devices.types.switch',            … },
  dimmer:          { type: 'devices.types.light',             … },
  pwm:             { type: 'devices.types.light',             … },
  pwm_rgb:         { type: 'devices.types.light',             … },
  dali:            { type: 'devices.types.light',             … },
  dali_group:      { type: 'devices.types.light',             … },
  ds18b20:         { type: 'devices.types.sensor',            … },
  dht_temp:        { type: 'devices.types.sensor',            … },
  dht_humidity:    { type: 'devices.types.sensor',            … },
  adc:             { type: 'devices.types.sensor',            … },
  climate_control: { type: 'devices.types.thermostat',        … },
  aqua_protect:    { type: 'devices.types.openable',          … },
  curtains:        { type: 'devices.types.openable.curtain',  … },
  script:          { type: 'devices.types.other',             … },
  scene:           { type: 'devices.types.other',             … },
};
```

Any P4 device kind NOT in this map returns `null` from `mapP4DeviceToYandex()` and is silently filtered in `mapP4InventoryToYandex()`.

## Adding a New Device Kind

1. Add the kind to `P4DeviceKind` union type in `src/services/p4.service.ts`
2. Add a mapping entry to `KIND_MAP` in `src/mappers/device.mapper.ts`
3. Add state mapping in the `switch(kind)` block in `src/mappers/state.mapper.ts`
4. Add action mapping (if applicable) in `src/mappers/action.mapper.ts`
5. Add a test case in `src/__tests__/mappers/device.mapper.test.ts`

## Partial Device Handling

A device may be in the allowlist but have incomplete state from P4:

| Missing state | Behaviour |
|--------------|-----------|
| `on` property missing | `on_off` capability omitted from state response |
| `brightness` missing | `range(brightness)` omitted from state response |
| Any HSV component missing | `color_setting` omitted from state response |
| Device `online: false` | `DEVICE_UNREACHABLE` error in query/action |
| Device not returned by P4 | `DEVICE_NOT_FOUND` error |

**Never returns null/invalid fields.** If a capability cannot be populated from P4 state, it is omitted rather than set to null or a default value.

## Fail-Fast on Schema Mismatch

- Yandex device types are a TypeScript discriminated union — adding an invalid type causes a compile error
- `satisfies` constraints on response objects catch mapping errors at build time
- `noUncheckedIndexedAccess: true` prevents silent undefined reads from capability arrays
- Exhaustiveness guard in `state.mapper.ts` catches unmapped kinds at compile time

## Log Example (filtered device)

```json
{
  "level": 20,
  "kind": "wifi_relay_legacy",
  "deviceId": "wifi-01",
  "msg": "Device kind not supported in Yandex — skipped from discovery"
}
```
