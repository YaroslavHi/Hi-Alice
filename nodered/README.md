# Node-RED P4 Relay

This directory contains the Node-RED configuration for the P4 relay bridge.
The relay translates the alice-adapter's HTTP P4 API into MQTT commands for the
real HI SmartBox controller.

## Files

| File | Purpose |
|------|---------|
| `flows.json` | Node-RED flow definitions (3 tabs) |
| `settings.js` | Node-RED runtime settings template |
| `mosquitto.conf` | Local MQTT broker config (for testing without a real broker) |

## Flow tabs

### MQTT Monitor
Subscribes to `demo/v1/server/devices/#` and logs all incoming messages.
Use this tab to discover device IDs and field names from the real controller.

### State-Change Tester
Inject buttons for manually triggering device state changes.
Used for testing the P4 relay without Yandex involvement.

### Real Controller Relay
The production flow. Implements the full P4 HTTP API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/internal/v1/houses/:house_id/devices` | GET | Inventory — static device list |
| `/internal/v1/houses/:house_id/devices/state` | POST | State — reads from MQTT cache |
| `/internal/v1/houses/:house_id/devices/action` | POST | Action — publishes to MQTT |

**Authorization:** `Bearer hi-relay-token-CHANGE_ME` (set `P4_RELAY_TOKEN` in alice-adapter `.env`)

## MQTT topic convention

```
Read  (controller → cloud): demo/v1/server/devices/{device_id}/{field}
Write (cloud → controller): demo/v1/client/devices/{device_id}/State
```

Field names:

| Field | Type | Description |
|-------|------|-------------|
| `State` | `True` / `False` | Relay on/off state |
| `TemperatureValue` | float string | Temperature in °C |
| `HumidityValue` | float string | Humidity in % |

## Customising the device inventory

Edit the `fn-inventory` function node in `flows.json`:

```javascript
devices: [
  {
    logical_device_id: 'your_device_id',   // as seen in MQTT topic
    kind: 'relay',                          // see docs/mapping.md for all kinds
    semantics: 'light',                     // 'light' | 'socket' | 'motion' | 'door' | 'button'
    name: 'Device name in Russian',
    room: 'Room name',
    online: true,
    board_id: 'controller-01'
  }
]
```

Also update the `KIND` map in `fn-state`:
```javascript
const KIND = {
  'your_device_id': 'relay',
};
```

## Debounce

The `fn-action` node implements a **150ms per-device debounce** to prevent
flooding the MQTT broker when Yandex sends rapid consecutive commands (e.g.
holding a brightness slider). Duplicate commands within the window are dropped
silently and return a success response.

## Deployment

See [docs/DEPLOYMENT.md §4](../docs/DEPLOYMENT.md) for full deployment instructions.

Quick start:
```bash
docker compose -f docker-compose.yml -f docker-compose.nodered.yml up -d
docker compose logs nodered | grep "Connected to broker"
```
