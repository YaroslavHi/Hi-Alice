# Admin API

REST API for managing houses and device inventory. Protected by `X-Admin-Key` header.

Set `ADMIN_API_KEY` (min 32 chars) in the service `.env`.

All requests must include:
```
X-Admin-Key: {ADMIN_API_KEY}
Content-Type: application/json
```

---

## Houses

### Create house

```
POST /admin/v1/houses
```

```json
{
  "house_id":        "sb-00A3F2",
  "display_name":    "Офис на Тверской",
  "owner_login":     "office-admin",
  "owner_password":  "secret",
  "mqtt_broker_url": "mqtts://mymqtt.ru:8883",
  "mqtt_username":   "user",
  "mqtt_password":   "mqttpassword",
  "mqtt_topic_prefix": "demo/v1"
}
```

`mqtt_username`, `mqtt_password`, `mqtt_topic_prefix` are optional. Password is hashed with scrypt before storage. MQTT password is encrypted with AES-256-GCM.

Returns `201` + house record (no password fields).

---

### List houses

```
GET /admin/v1/houses
```

Returns `200` + `{ houses: HouseRecord[] }`.

---

### Get house

```
GET /admin/v1/houses/:houseId
```

Returns `200` + house record, or `404` if not found.

---

### Update house

```
PATCH /admin/v1/houses/:houseId
```

All fields optional. `owner_password` is re-hashed on update.

```json
{
  "display_name": "Новое название",
  "active": false
}
```

Returns `200` + updated house record.

---

### Delete house

```
DELETE /admin/v1/houses/:houseId
```

Cascades to all devices. Returns `204` on success.

---

## Devices

### List devices for a house

```
GET /admin/v1/houses/:houseId/devices
```

Returns `200` + `{ devices: DeviceRecord[] }`.

---

### Upsert device

```
POST /admin/v1/houses/:houseId/devices
```

Creates or updates one device. The `(house_id, logical_device_id)` pair is the primary key.

```json
{
  "logical_device_id": "switch_903858",
  "kind":              "relay",
  "semantics":         "light",
  "name":              "Офисный свет",
  "room":              "Офис",
  "board_id":          "real-controller-01",
  "meta":              { "brightness_min": 5, "brightness_max": 95 },
  "enabled":           true,
  "sort_order":        0
}
```

`semantics`, `board_id`, `meta`, `enabled`, `sort_order` are optional.

Returns `200` + device record.

---

### Bulk upsert devices

```
POST /admin/v1/houses/:houseId/devices/bulk
```

```json
{
  "devices": [ { ...DeviceUpsert }, ... ],
  "replace": false
}
```

`replace: true` — deletes all existing devices for the house first, then inserts. `replace: false` — upserts without deleting.

Returns `200` + `{ upserted: number }`.

---

### Update device

```
PATCH /admin/v1/houses/:houseId/devices/:deviceId
```

Partial update. All fields optional.

Returns `200` + updated device record, or `404` if device not found.

---

### Delete device

```
DELETE /admin/v1/houses/:houseId/devices/:deviceId
```

Returns `204` on success, `404` if not found.

---

## Auth

### Verify credentials

```
POST /admin/v1/auth/verify
```

Verifies a house owner's login/password (same credentials as the built-in login page).

```json
{
  "login":    "office-admin",
  "password": "secret"
}
```

Returns `200 { valid: true, house_id: "sb-00A3F2" }` or `200 { valid: false }`.

---

## Password storage

House passwords are hashed with **scrypt** (N=16384, r=8, p=1) and stored as `scrypt:{salt_hex}:{hash_hex}`. Passwords are never returned by any API endpoint.

MQTT passwords are encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`.
