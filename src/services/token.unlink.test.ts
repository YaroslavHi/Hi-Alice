/**
 * @file services/token.unlink.test.ts
 *
 * Tests for unlink immediate cache invalidation (DEFECT G fix).
 *
 * Verifies that:
 *  - ValidatedToken now carries access_token_hmac
 *  - unlinkAccount uses the HMAC to hard-delete the Redis cache key
 *  - Old token is not usable after unlink (cache no longer returns it)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ValidatedToken } from '../types/internal.js';

// ─── Verify ValidatedToken structure ─────────────────────────────────────────

describe('ValidatedToken includes access_token_hmac (DEFECT G fix)', () => {
  it('ValidatedToken type has access_token_hmac field', () => {
    // This test exists to make the type contract explicit and catch regression.
    const token: ValidatedToken = {
      access_token_id:   'test-id',
      access_token_hmac: 'test-hmac-value',  // must compile — field must exist in type
      user_id:           'user-1',
      house_id:          'house-1',
      yandex_user_id:    'yandex-1',
      scope:             '',
      expires_at:        new Date(Date.now() + 86400 * 1000),
    };
    expect(token.access_token_hmac).toBe('test-hmac-value');
  });
});

// ─── Mock-based unlink invalidation test ─────────────────────────────────────

describe('unlinkAccount hard-invalidates Redis cache (DEFECT G fix)', () => {
  let redisDel: ReturnType<typeof vi.fn>;
  let pgExecute: ReturnType<typeof vi.fn>;
  let mockApp: any;

  const token: ValidatedToken = {
    access_token_id:   'link-id-123',
    access_token_hmac: 'hmac-abc123',
    user_id:           'owner-1',
    house_id:          'house-1',
    yandex_user_id:    'yandex-uid-1',
    scope:             '',
    expires_at:        new Date(Date.now() + 86400 * 1000),
  };

  beforeEach(() => {
    redisDel  = vi.fn().mockResolvedValue(1);
    pgExecute = vi.fn().mockResolvedValue([]);

    mockApp = {
      log:   { info: vi.fn(), warn: vi.fn() },
      redis: { del: redisDel },
      pg:    new Proxy({}, {
        get: () => pgExecute,
        apply: (_t, _this, _args) => pgExecute(),
      }),
    };

    // Make pg a tagged-template function
    mockApp.pg = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
      void strings;
      return Promise.resolve([]);
    };
  });

  it('calls redis.del with the correct cache key', async () => {
    // Import after mocks are ready
    const { unlinkAccount } = await import('./token.service.js');

    // Replace redis.del to capture calls
    const delSpy = vi.fn().mockResolvedValue(1);
    mockApp.redis.del = delSpy;

    await unlinkAccount(mockApp, token, '127.0.0.1', 'req-001');

    // Must call del with the correct cache key format: alice:link:{hmac}
    expect(delSpy).toHaveBeenCalledWith(`alice:link:${token.access_token_hmac}`);
  });

  it('completes unlink even if redis.del throws', async () => {
    const { unlinkAccount } = await import('./token.service.js');

    mockApp.redis.del = vi.fn().mockRejectedValue(new Error('Redis connection lost'));

    // Should not throw — redis failure is best-effort, logged as warn
    await expect(
      unlinkAccount(mockApp, token, '127.0.0.1', 'req-002'),
    ).resolves.toBeUndefined();
  });
});
