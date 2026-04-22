import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'crypto';
import type postgres from 'postgres';
import type { HouseRecord, DeviceRecord, DeviceUpsert, HouseCreate } from '../types/internal.js';
import { env } from '../config/env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM      = 'aes-256-gcm' as const;
const IV_BYTES       = 12;
const AUTH_TAG_BYTES = 16;
const SALT_BYTES     = 32;
const HASH_BYTES     = 64;
const SCRYPT_PARAMS  = { N: 16384, r: 8, p: 1 } as const;

// ─── Key buffer (derived once) ────────────────────────────────────────────────

let _encKey: Buffer | null = null;

function getEncKey(): Buffer {
  if (!_encKey) _encKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');
  return _encKey;
}

// ─── Password hashing (scrypt) ────────────────────────────────────────────────

function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, HASH_BYTES, SCRYPT_PARAMS);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt     = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const derived  = scryptSync(password, salt, HASH_BYTES, SCRYPT_PARAMS);
  return timingSafeEqual(derived, expected);
}

// ─── MQTT password encryption (AES-256-GCM) ──────────────────────────────────

function encryptMqttPassword(plain: string): string {
  const iv         = randomBytes(IV_BYTES);
  const cipher     = createCipheriv(ALGORITHM, getEncKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptMqttPassword(enc: string): string {
  const parts = enc.split(':');
  if (parts.length !== 3) throw new Error('Invalid mqtt_password_enc format');
  const iv         = Buffer.from(parts[0]!, 'hex');
  const tag        = Buffer.from(parts[1]!, 'hex');
  const ciphertext = Buffer.from(parts[2]!, 'hex');
  const decipher   = createDecipheriv(ALGORITHM, getEncKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─── House CRUD ───────────────────────────────────────────────────────────────

export async function createHouse(sql: postgres.Sql<{}>, data: HouseCreate): Promise<HouseRecord> {
  const passwordHash = hashPassword(data.owner_password);
  const mqttPasswordEnc = data.mqtt_password ? encryptMqttPassword(data.mqtt_password) : null;

  const [row] = await sql<HouseRecord[]>`
    INSERT INTO houses (
      house_id, display_name, owner_login, owner_password_hash,
      mqtt_broker_url, mqtt_username, mqtt_password_enc, mqtt_topic_prefix
    ) VALUES (
      ${data.house_id},
      ${data.display_name},
      ${data.owner_login},
      ${passwordHash},
      ${data.mqtt_broker_url},
      ${data.mqtt_username ?? null},
      ${mqttPasswordEnc},
      ${data.mqtt_topic_prefix ?? 'demo/v1'}
    )
    RETURNING
      house_id, display_name, owner_login, mqtt_broker_url,
      mqtt_username, mqtt_topic_prefix, active, created_at, updated_at
  `;
  return row!;
}

export async function getHouse(sql: postgres.Sql<{}>, house_id: string): Promise<HouseRecord | null> {
  const rows = await sql<HouseRecord[]>`
    SELECT house_id, display_name, owner_login, mqtt_broker_url,
           mqtt_username, mqtt_topic_prefix, active, created_at, updated_at
    FROM houses
    WHERE house_id = ${house_id}
  `;
  return rows[0] ?? null;
}

export async function listHouses(sql: postgres.Sql<{}>): Promise<HouseRecord[]> {
  return sql<HouseRecord[]>`
    SELECT house_id, display_name, owner_login, mqtt_broker_url,
           mqtt_username, mqtt_topic_prefix, active, created_at, updated_at
    FROM houses
    ORDER BY display_name
  `;
}

export async function updateHouse(
  sql: postgres.Sql<{}>,
  house_id: string,
  patch: Partial<{
    display_name:      string;
    owner_login:       string;
    owner_password:    string;
    mqtt_broker_url:   string;
    mqtt_username:     string;
    mqtt_password:     string;
    mqtt_topic_prefix: string;
    active:            boolean;
  }>,
): Promise<HouseRecord | null> {
  const updates: Record<string, unknown> = {};

  if (patch.display_name      !== undefined) updates['display_name']       = patch.display_name;
  if (patch.owner_login       !== undefined) updates['owner_login']        = patch.owner_login;
  if (patch.owner_password    !== undefined) updates['owner_password_hash'] = hashPassword(patch.owner_password);
  if (patch.mqtt_broker_url   !== undefined) updates['mqtt_broker_url']    = patch.mqtt_broker_url;
  if (patch.mqtt_username     !== undefined) updates['mqtt_username']      = patch.mqtt_username;
  if (patch.mqtt_password     !== undefined) updates['mqtt_password_enc']  = encryptMqttPassword(patch.mqtt_password);
  if (patch.mqtt_topic_prefix !== undefined) updates['mqtt_topic_prefix']  = patch.mqtt_topic_prefix;
  if (patch.active            !== undefined) updates['active']             = patch.active;

  if (Object.keys(updates).length === 0) return getHouse(sql, house_id);

  const rows = await sql<HouseRecord[]>`
    UPDATE houses
    SET ${sql(updates)}, updated_at = now()
    WHERE house_id = ${house_id}
    RETURNING
      house_id, display_name, owner_login, mqtt_broker_url,
      mqtt_username, mqtt_topic_prefix, active, created_at, updated_at
  `;
  return rows[0] ?? null;
}

export async function deleteHouse(sql: postgres.Sql<{}>, house_id: string): Promise<boolean> {
  const result = await sql`DELETE FROM houses WHERE house_id = ${house_id}`;
  return result.count > 0;
}

export async function verifyHouseCredentials(
  sql: postgres.Sql<{}>,
  login: string,
  password: string,
): Promise<HouseRecord | null> {
  const rows = await sql<(HouseRecord & { ownerPasswordHash: string })[]>`
    SELECT house_id, display_name, owner_login, owner_password_hash,
           mqtt_broker_url, mqtt_username, mqtt_topic_prefix, active, created_at, updated_at
    FROM houses
    WHERE owner_login = ${login}
  `;
  const row = rows[0];
  if (!row) return null;
  if (!verifyPassword(password, row.ownerPasswordHash)) return null;
  const { ownerPasswordHash: _, ...house } = row;
  return house as HouseRecord;
}

// ─── Device CRUD ──────────────────────────────────────────────────────────────

export async function listDevices(sql: postgres.Sql<{}>, house_id: string): Promise<DeviceRecord[]> {
  return sql<DeviceRecord[]>`
    SELECT house_id, logical_device_id, kind, semantics, name, room,
           board_id, meta, enabled, sort_order, created_at, updated_at
    FROM devices
    WHERE house_id = ${house_id} AND enabled = TRUE
    ORDER BY sort_order, name
  `;
}

export async function listAllDevices(sql: postgres.Sql<{}>, house_id: string): Promise<DeviceRecord[]> {
  return sql<DeviceRecord[]>`
    SELECT house_id, logical_device_id, kind, semantics, name, room,
           board_id, meta, enabled, sort_order, created_at, updated_at
    FROM devices
    WHERE house_id = ${house_id}
    ORDER BY sort_order, name
  `;
}

export async function upsertDevice(
  sql: postgres.Sql<{}>,
  house_id: string,
  device: DeviceUpsert,
): Promise<DeviceRecord> {
  const [row] = await sql<DeviceRecord[]>`
    INSERT INTO devices (
      house_id, logical_device_id, kind, semantics, name, room,
      board_id, meta, enabled, sort_order
    ) VALUES (
      ${house_id},
      ${device.logical_device_id},
      ${device.kind},
      ${device.semantics ?? null},
      ${device.name},
      ${device.room},
      ${device.board_id ?? null},
      ${device.meta ? sql.json(device.meta as any) : null},
      ${device.enabled ?? true},
      ${device.sort_order ?? 0}
    )
    ON CONFLICT (house_id, logical_device_id) DO UPDATE SET
      kind       = EXCLUDED.kind,
      semantics  = EXCLUDED.semantics,
      name       = EXCLUDED.name,
      room       = EXCLUDED.room,
      board_id   = EXCLUDED.board_id,
      meta       = EXCLUDED.meta,
      enabled    = EXCLUDED.enabled,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING
      house_id, logical_device_id, kind, semantics, name, room,
      board_id, meta, enabled, sort_order, created_at, updated_at
  `;
  return row!;
}

export async function upsertDevices(
  sql: postgres.Sql<{}>,
  house_id: string,
  devices: DeviceUpsert[],
): Promise<DeviceRecord[]> {
  return sql.begin(async (tx) => {
    const results: DeviceRecord[] = [];
    for (const device of devices) {
      results.push(await upsertDevice(tx as unknown as postgres.Sql<{}>, house_id, device));
    }
    return results;
  });
}

export async function updateDevice(
  sql: postgres.Sql<{}>,
  house_id: string,
  logical_device_id: string,
  patch: Partial<DeviceUpsert & { enabled: boolean }>,
): Promise<DeviceRecord | null> {
  const updates: Record<string, unknown> = {};

  if (patch.kind              !== undefined) updates['kind']       = patch.kind;
  if (patch.semantics         !== undefined) updates['semantics']  = patch.semantics;
  if (patch.name              !== undefined) updates['name']       = patch.name;
  if (patch.room              !== undefined) updates['room']       = patch.room;
  if (patch.board_id          !== undefined) updates['board_id']   = patch.board_id;
  if (patch.meta              !== undefined) updates['meta']       = sql.json(patch.meta as any);
  if (patch.enabled           !== undefined) updates['enabled']    = patch.enabled;
  if (patch.sort_order        !== undefined) updates['sort_order'] = patch.sort_order;

  if (Object.keys(updates).length === 0) {
    const rows = await sql<DeviceRecord[]>`
      SELECT house_id, logical_device_id, kind, semantics, name, room,
             board_id, meta, enabled, sort_order, created_at, updated_at
      FROM devices
      WHERE house_id = ${house_id} AND logical_device_id = ${logical_device_id}
    `;
    return rows[0] ?? null;
  }

  const rows = await sql<DeviceRecord[]>`
    UPDATE devices
    SET ${sql(updates)}, updated_at = now()
    WHERE house_id = ${house_id} AND logical_device_id = ${logical_device_id}
    RETURNING
      house_id, logical_device_id, kind, semantics, name, room,
      board_id, meta, enabled, sort_order, created_at, updated_at
  `;
  return rows[0] ?? null;
}

export async function deleteDevice(
  sql: postgres.Sql<{}>,
  house_id: string,
  logical_device_id: string,
): Promise<boolean> {
  const result = await sql`
    DELETE FROM devices
    WHERE house_id = ${house_id} AND logical_device_id = ${logical_device_id}
  `;
  return result.count > 0;
}
