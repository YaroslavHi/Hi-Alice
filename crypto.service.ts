/**
 * @module services/crypto.service
 *
 * Token security layer — two complementary operations:
 *
 * ENCRYPTION (AES-256-GCM)
 *   encrypt(raw) → ciphertext stored in alice_account_links.access_token_encrypted
 *   decrypt(ciphertext) → raw token (when we need the original value)
 *   Purpose: tokens are RECOVERABLE if needed; DB compromise alone is not sufficient
 *            to extract usable tokens (key lives outside DB).
 *
 * HMAC (HMAC-SHA256)
 *   hmac(raw) → deterministic 64-char hex stored in alice_account_links.access_token_hmac
 *   Purpose: O(1) constant-time lookup — no decryption required for validation.
 *            SELECT WHERE access_token_hmac = $1 finds the link in one indexed query.
 *
 * Why both?
 *   Hashing alone (argon2): one-way, can't recover token, slow (~100ms) on every request.
 *   HMAC alone: fast lookup but doesn't meet "encrypted at rest" requirement.
 *   AES alone: can validate but requires decryption on every request (slow + complex).
 *   HMAC + AES: fast lookup via HMAC, encrypted storage via AES. Best of both.
 *
 * Security properties:
 *   - HMAC key ≠ encryption key — separate secrets, separate attack surfaces.
 *   - AES-256-GCM provides authenticated encryption — detects tampering.
 *   - Each encrypt() call uses a fresh random IV — same plaintext → different ciphertext.
 *   - Keys live in env, never in DB.
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM     = 'aes-256-gcm' as const;
const IV_BYTES      = 12;   // 96-bit IV recommended for GCM
const AUTH_TAG_BYTES = 16;  // GCM authentication tag

// ─── Key buffers (derived once from hex env vars) ─────────────────────────────

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

let _encKey: Buffer | null = null;
let _hmacKey: Buffer | null = null;

function getEncKey(): Buffer {
  if (!_encKey) _encKey = hexToBuffer(env.TOKEN_ENCRYPTION_KEY);
  return _encKey;
}

function getHmacKey(): Buffer {
  if (!_hmacKey) _hmacKey = hexToBuffer(env.TOKEN_HMAC_KEY);
  return _hmacKey;
}

// ─── HMAC ─────────────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256(token, TOKEN_HMAC_KEY).
 * Returns a deterministic 64-char hex string suitable for indexed DB lookup.
 * Constant-time by construction (fixed-length output).
 */
export function computeTokenHmac(rawToken: string): string {
  return createHmac('sha256', getHmacKey())
    .update(rawToken, 'utf8')
    .digest('hex');
}

// ─── AES-256-GCM Encryption ───────────────────────────────────────────────────

/** Encrypted token format: base64(iv + authTag + ciphertext) */
export function encryptToken(rawToken: string): string {
  const iv         = randomBytes(IV_BYTES);
  const cipher     = createCipheriv(ALGORITHM, getEncKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(rawToken, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: [iv (12B)] + [authTag (16B)] + [ciphertext (variable)]
  const packed = Buffer.concat([iv, authTag, ciphertext]);
  return packed.toString('base64');
}

/** Decrypt a token previously encrypted with encryptToken(). */
export function decryptToken(encryptedB64: string): string {
  const packed     = Buffer.from(encryptedB64, 'base64');
  const iv         = packed.subarray(0, IV_BYTES);
  const authTag    = packed.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, getEncKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

// ─── Auth code hashing (still uses HMAC — codes are short-lived, verify-only) ─

/**
 * Hash an auth code for storage.
 * Auth codes are verify-only (not retrieved), so HMAC is sufficient.
 * We don't need AES here since we never need to recover the original code.
 */
export function computeCodeHmac(rawCode: string): string {
  return computeTokenHmac(rawCode);
}
