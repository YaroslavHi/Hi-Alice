-- ============================================================
-- HI SmartBox — Alice Adapter — PostgreSQL Schema
-- Matches A2 spec exactly: alice_account_links with encrypted tokens
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Auth codes (short-lived, one-use) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hmac      TEXT        NOT NULL UNIQUE,        -- HMAC-SHA256 of raw code
  client_id      TEXT        NOT NULL,
  hi_house_id    TEXT        NOT NULL,
  hi_owner_account_id TEXT   NOT NULL,
  redirect_uri   TEXT        NOT NULL,
  scope          TEXT        NOT NULL DEFAULT '',
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON oauth_auth_codes (expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE oauth_auth_codes IS
  'Short-lived OAuth 2.0 auth codes. Verified via HMAC; never decrypted.';

-- ─── Account links (A2 spec — primary OAuth table) ────────────────────────────
--
-- One row per active account link.
-- "one active link per house; new link replaces old" enforced by UPSERT on (hi_house_id).
--
-- Tokens are:
--   *_encrypted  : AES-256-GCM ciphertext (recoverable, at-rest security)
--   *_hmac       : HMAC-SHA256 (fast indexed lookup, constant-time comparison)

CREATE TABLE IF NOT EXISTS alice_account_links (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HI domain identifiers
  hi_house_id              TEXT        NOT NULL,
  hi_owner_account_id      TEXT        NOT NULL,

  -- Yandex identity
  yandex_user_id           TEXT        NOT NULL,

  -- Access token (AES-256-GCM encrypted + HMAC for lookup)
  access_token_encrypted   TEXT        NOT NULL,
  access_token_hmac        TEXT        NOT NULL UNIQUE,  -- indexed lookup key
  access_token_expires_at  TIMESTAMPTZ NOT NULL,

  -- Refresh token (AES-256-GCM encrypted + HMAC for lookup)
  refresh_token_encrypted  TEXT        NOT NULL,
  refresh_token_hmac       TEXT        NOT NULL UNIQUE,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,

  -- Link lifecycle
  link_status  TEXT        NOT NULL DEFAULT 'active'
                           CHECK (link_status IN ('active', 'unlinked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active link per house; on re-link the row is updated in place.
  CONSTRAINT uq_alice_link_house UNIQUE (hi_house_id)
);

CREATE INDEX IF NOT EXISTS idx_alice_links_access_hmac
  ON alice_account_links (access_token_hmac)
  WHERE link_status = 'active';

CREATE INDEX IF NOT EXISTS idx_alice_links_refresh_hmac
  ON alice_account_links (refresh_token_hmac)
  WHERE link_status = 'active';

CREATE INDEX IF NOT EXISTS idx_alice_links_yandex_user
  ON alice_account_links (yandex_user_id)
  WHERE link_status = 'active';

COMMENT ON TABLE alice_account_links IS
  'OAuth 2.0 account links. One active link per house (hi_house_id UNIQUE). '
  'Tokens stored AES-256-GCM encrypted; HMAC columns enable O(1) lookup.';

-- ─── Audit log ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alice_audit_log (
  id            BIGSERIAL   PRIMARY KEY,
  event_type    TEXT        NOT NULL,
  hi_house_id   TEXT,
  hi_owner_account_id TEXT,
  yandex_user_id TEXT,
  ip_addr       INET,
  request_id    TEXT,
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_house
  ON alice_audit_log (hi_house_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event
  ON alice_audit_log (event_type, created_at DESC);

COMMENT ON TABLE alice_audit_log IS 'Append-only security audit trail.';

-- ─── Houses (SmartBox controller instances) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS houses (
  house_id            TEXT        PRIMARY KEY,          -- 'sb-00A3F2'
  display_name        TEXT        NOT NULL,             -- 'Офис на Тверской'
  owner_login         TEXT        NOT NULL UNIQUE,      -- login for HI auth
  owner_password_hash TEXT        NOT NULL,             -- scrypt hash
  mqtt_broker_url     TEXT        NOT NULL,             -- 'mqtts://mymqtt.ru:8883'
  mqtt_username       TEXT,
  mqtt_password_enc   TEXT,                             -- AES-256-GCM encrypted
  mqtt_topic_prefix   TEXT        NOT NULL DEFAULT 'demo/v1',
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE houses IS 'SmartBox controller instances. One row per customer house.';

-- ─── Devices per house ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devices (
  house_id            TEXT        NOT NULL REFERENCES houses(house_id) ON DELETE CASCADE,
  logical_device_id   TEXT        NOT NULL,             -- 'switch_903858'
  kind                TEXT        NOT NULL,             -- 'relay','ds18b20','turkov',...
  semantics           TEXT,                             -- 'light','socket','motion',...
  name                TEXT        NOT NULL,             -- 'Люстра в гостиной'
  room                TEXT        NOT NULL,             -- 'Гостиная'
  board_id            TEXT,
  meta                JSONB,                            -- kind-specific params
  enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order          INTEGER     NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (house_id, logical_device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_house
  ON devices(house_id)
  WHERE enabled = TRUE;

COMMENT ON TABLE devices IS
  'Device inventory per house. Source of truth for device names, rooms, and kinds. '
  'P4 relay is queried only for live state values.';

COMMIT;
