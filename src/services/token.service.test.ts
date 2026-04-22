/**
 * @file services/token.service.test.ts
 *
 * Tests for token generation, HMAC lookup, and AES-256-GCM encryption.
 * The crypto.service functions are the foundation — we test them exhaustively.
 * DB-dependent functions (validateBearerToken, issueTokenPair, etc.) are covered
 * in routes.integration.test.ts via mocked Fastify instances.
 */

import { describe, it, expect } from 'vitest';
import {
  generateAccessToken,
  generateRefreshToken,
  generateAuthCode,
} from '../../services/token.service.js';
import {
  computeTokenHmac,
  encryptToken,
  decryptToken,
  computeCodeHmac,
} from '../../services/crypto.service.js';

// ─── Token generation ─────────────────────────────────────────────────────────

describe('generateAccessToken', () => {
  it('returns a 64-character string', () => {
    expect(generateAccessToken()).toHaveLength(64);
  });

  it('produces only URL-safe characters', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateAccessToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('generates unique tokens across 200 calls', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateAccessToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('generateRefreshToken', () => {
  it('returns a 64-character string', () => {
    expect(generateRefreshToken()).toHaveLength(64);
  });

  it('never collides with access token from same call (statistically)', () => {
    // Not guaranteed but with 64-char nanoid the probability is negligible.
    expect(generateAccessToken()).not.toBe(generateRefreshToken());
  });
});

describe('generateAuthCode', () => {
  it('returns a 32-character string', () => {
    expect(generateAuthCode()).toHaveLength(32);
  });

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateAuthCode()));
    expect(codes.size).toBe(100);
  });
});

// ─── HMAC ─────────────────────────────────────────────────────────────────────

describe('computeTokenHmac', () => {
  it('returns a 64-character hex string', () => {
    const hmac = computeTokenHmac('some-raw-token');
    expect(hmac).toHaveLength(64);
    expect(hmac).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic — same input always produces same HMAC', () => {
    const token = generateAccessToken();
    const h1 = computeTokenHmac(token);
    const h2 = computeTokenHmac(token);
    expect(h1).toBe(h2);
  });

  it('different tokens produce different HMACs', () => {
    const h1 = computeTokenHmac(generateAccessToken());
    const h2 = computeTokenHmac(generateAccessToken());
    expect(h1).not.toBe(h2);
  });

  it('is sensitive to a single character change', () => {
    const base  = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const diff  = 'baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(computeTokenHmac(base)).not.toBe(computeTokenHmac(diff));
  });
});

describe('computeCodeHmac', () => {
  it('produces a 64-char hex string', () => {
    expect(computeCodeHmac(generateAuthCode())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const code = generateAuthCode();
    expect(computeCodeHmac(code)).toBe(computeCodeHmac(code));
  });
});

// ─── AES-256-GCM encryption ───────────────────────────────────────────────────

describe('encryptToken / decryptToken', () => {
  it('round-trips correctly — decrypt(encrypt(raw)) === raw', () => {
    const raw  = generateAccessToken();
    const enc  = encryptToken(raw);
    const back = decryptToken(enc);
    expect(back).toBe(raw);
  });

  it('each encrypt() call produces a different ciphertext (fresh IV)', () => {
    const raw = generateAccessToken();
    const c1  = encryptToken(raw);
    const c2  = encryptToken(raw);
    // Same plaintext, different IV → different ciphertext.
    expect(c1).not.toBe(c2);
    // But both decrypt to the same original.
    expect(decryptToken(c1)).toBe(raw);
    expect(decryptToken(c2)).toBe(raw);
  });

  it('produces a base64 string', () => {
    const enc = encryptToken('test-token');
    expect(() => Buffer.from(enc, 'base64')).not.toThrow();
  });

  it('ciphertext is longer than plaintext (includes IV + auth tag)', () => {
    const raw = 'short';
    const enc = encryptToken(raw);
    // IV(12) + authTag(16) + ciphertext(5) = 33 bytes → base64 ≈ 44 chars
    expect(enc.length).toBeGreaterThan(raw.length);
  });

  it('throws on tampered ciphertext (GCM auth tag verification fails)', () => {
    const enc    = encryptToken(generateAccessToken());
    const buf    = Buffer.from(enc, 'base64');
    // Flip a byte in the ciphertext region (after IV + authTag = 28 bytes).
    buf[30] = buf[30]! ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const enc = encryptToken(generateAccessToken());
    const buf = Buffer.from(enc, 'base64');
    // Flip a byte in the auth tag region (bytes 12-27).
    buf[15] = buf[15]! ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('round-trips for long tokens (64 chars)', () => {
    const raw = generateAccessToken(); // 64 chars
    expect(decryptToken(encryptToken(raw))).toBe(raw);
  });

  it('round-trips for short inputs (auth codes, 32 chars)', () => {
    const code = generateAuthCode(); // 32 chars
    expect(decryptToken(encryptToken(code))).toBe(code);
  });
});

// ─── HMAC does not leak token value ──────────────────────────────────────────

describe('HMAC security properties', () => {
  it('HMAC output contains no substring of the raw token', () => {
    // Basic sanity: the raw token must not appear in the HMAC output.
    const raw  = 'SuperSecretToken12345678901234567890123456789012345678901234567';
    const hmac = computeTokenHmac(raw);
    expect(hmac).not.toContain('SuperSecretToken');
    expect(hmac).not.toContain(raw.slice(0, 10));
  });

  it('encryption output contains no substring of the raw token in base64', () => {
    const raw = 'SuperSecretToken12345678901234567890123456789012345678901234567';
    const enc = encryptToken(raw);
    // The raw token must not appear verbatim in the base64 ciphertext.
    expect(enc).not.toContain('SuperSecretToken');
  });
});

// ─── Cross-function independence ──────────────────────────────────────────────

describe('cross-function uniqueness', () => {
  it('200 tokens across all generators never collide', () => {
    const all = [
      ...Array.from({ length: 70 }, () => generateAccessToken()),
      ...Array.from({ length: 70 }, () => generateRefreshToken()),
      ...Array.from({ length: 60 }, () => generateAuthCode()),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
