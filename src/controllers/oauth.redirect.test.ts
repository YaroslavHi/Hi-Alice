/**
 * @file controllers/oauth.redirect.test.ts
 *
 * Tests for OAuth redirect URI allowlist validation.
 *
 * DEFECT F fix: validates that the tightened redirect URI check accepts only
 * exact URIs from the allowlist, not broad hostname suffix matching.
 *
 * The function under test is the logic extracted from oauth.controller.ts.
 * We test the logic directly since the env is loaded at module level.
 */

import { describe, it, expect } from 'vitest';

// ─── The exact allowlist logic extracted for unit testing ─────────────────────
// This mirrors what oauth.controller.ts does at startup.

function makeAllowlist(raw: string): ReadonlySet<string> {
  return new Set(raw.split(',').map((u) => u.trim()).filter(Boolean));
}

function validateRedirectUri(uri: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(uri);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OAuth redirect URI allowlist validation (DEFECT F fix)', () => {
  const defaultAllowlist = makeAllowlist('https://social.yandex.net/broker/redirect');

  describe('exact URI match', () => {
    it('accepts the default Yandex Smart Home redirect URI', () => {
      expect(validateRedirectUri('https://social.yandex.net/broker/redirect', defaultAllowlist)).toBe(true);
    });

    it('rejects URI not in allowlist', () => {
      expect(validateRedirectUri('https://social.yandex.net/other/path', defaultAllowlist)).toBe(false);
    });

    it('rejects arbitrary yandex.ru subdomains (old broad check was vulnerable)', () => {
      expect(validateRedirectUri('https://attacker.yandex.ru/callback', defaultAllowlist)).toBe(false);
      expect(validateRedirectUri('https://evil.yandex.net/redirect', defaultAllowlist)).toBe(false);
    });

    it('rejects non-Yandex URIs', () => {
      expect(validateRedirectUri('https://evil.com/callback', defaultAllowlist)).toBe(false);
      expect(validateRedirectUri('http://localhost:3000/callback', defaultAllowlist)).toBe(false);
    });

    it('rejects trailing slash variant', () => {
      expect(validateRedirectUri('https://social.yandex.net/broker/redirect/', defaultAllowlist)).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(validateRedirectUri('HTTPS://social.yandex.net/broker/redirect', defaultAllowlist)).toBe(false);
    });
  });

  describe('multi-URI allowlist', () => {
    const multiAllowlist = makeAllowlist(
      'https://social.yandex.net/broker/redirect, https://oauth.yandex.ru/verification_code',
    );

    it('accepts both configured URIs', () => {
      expect(validateRedirectUri('https://social.yandex.net/broker/redirect', multiAllowlist)).toBe(true);
      expect(validateRedirectUri('https://oauth.yandex.ru/verification_code', multiAllowlist)).toBe(true);
    });

    it('still rejects unlisted URIs', () => {
      expect(validateRedirectUri('https://social.yandex.net/broker/other', multiAllowlist)).toBe(false);
    });
  });

  describe('allowlist construction', () => {
    it('trims whitespace around entries', () => {
      const al = makeAllowlist('  https://social.yandex.net/broker/redirect  ');
      expect(al.has('https://social.yandex.net/broker/redirect')).toBe(true);
    });

    it('ignores empty entries from double commas', () => {
      const al = makeAllowlist('https://social.yandex.net/broker/redirect,,');
      expect(al.size).toBe(1);
    });
  });
});
