/**
 * @module config/env
 * Typed, validated environment configuration. Fails fast at startup.
 * NEVER expose values in logs or error responses.
 */
import { z } from 'zod';

const hexKey64 = z.string().length(64).regex(/^[0-9a-fA-F]+$/, 'Must be 64 hex chars (32 bytes)');

const envSchema = z.object({
  NODE_ENV:  z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // ── Database ───────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),

  // ── Redis ──────────────────────────────────────────────────────────────────
  REDIS_URL:      z.string().url(),
  REDIS_PASSWORD: z.string().optional(),

  // ── OAuth ──────────────────────────────────────────────────────────────────
  YANDEX_CLIENT_ID:     z.string().min(1),
  YANDEX_CLIENT_SECRET: z.string().min(16),
  HI_LOGIN_URL:         z.string().url(),
  SERVICE_BASE_URL:     z.string().url(),

  // ── Token security (A2) ────────────────────────────────────────────────────
  // AES-256-GCM key: encrypt tokens at rest so they're retrievable.
  TOKEN_ENCRYPTION_KEY: hexKey64,
  // HMAC-SHA256 key: fast constant-time lookup without decryption.
  TOKEN_HMAC_KEY:       hexKey64,

  // ── Token TTLs ─────────────────────────────────────────────────────────────
  ACCESS_TOKEN_TTL_SECONDS:  z.coerce.number().int().positive().default(2_592_000),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7_776_000),
  AUTH_CODE_TTL_SECONDS:     z.coerce.number().int().positive().default(600),

  // ── P4 Relay ───────────────────────────────────────────────────────────────
  P4_RELAY_URL:         z.string().url(),
  P4_RELAY_TOKEN:       z.string().min(16),
  P4_RELAY_TIMEOUT_MS:  z.coerce.number().int().positive().default(8_000),

  // ── Yandex Skill (outbound callbacks — A5) ─────────────────────────────────
  YANDEX_SKILL_ID:          z.string().default(''),
  YANDEX_SKILL_OAUTH_TOKEN: z.string().default(''),

  // ── Rate limiting ──────────────────────────────────────────────────────────
  RATE_LIMIT_MAX:       z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // ── Notification queue (A5) ────────────────────────────────────────────────
  NOTIFICATION_QUEUE_KEY:       z.string().default('alice:notif:queue'),
  NOTIFICATION_DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');
    process.stderr.write(`\n[alice-adapter] Invalid environment:\n${issues}\n\n`);
    process.exit(1);
  }
  return result.data;
}

export const env: Readonly<Env> = loadEnv();
