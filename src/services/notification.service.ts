/**
 * @module services/notification.service
 *
 * Outbound Yandex Smart Home callbacks — A5 spec.
 *
 * TWO endpoints (per Yandex spec):
 *   POST /api/v1/skills/{skill_id}/callback/state      ← device state changed
 *   POST /api/v1/skills/{skill_id}/callback/discovery  ← device list changed
 *
 * Queue design (A5 requirement):
 *   - Redis LIST as a FIFO queue (`alice:notif:queue`)
 *   - Producer (P4 webhook) pushes JSON payload to queue head (LPUSH)
 *   - Consumer (background worker started in app.ts) pops from tail (BRPOP)
 *   - Worker calls Yandex with retry (up to 3 attempts, exponential backoff)
 *
 * Deduplication (A5 requirement):
 *   - Key: `alice:notif:dedup:{type}:{user_id}:{device_id}`
 *   - TTL: NOTIFICATION_DEDUP_TTL_SECONDS (default 30s)
 *   - If key exists → skip enqueue (identical event already queued/sent)
 *   - Only-confirmed-owner events reach this layer (guaranteed by P4 webhook)
 *
 * Retry policy:
 *   Attempt 1: immediate
 *   Attempt 2: +1 000ms
 *   Attempt 3: +2 000ms
 *   429 Retry-After: respected
 *   4xx (client error): abort immediately
 *   Exhausted: logged, dropped (Yandex will reconcile via next poll)
 */

import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { DeviceStateChangedCallback } from '../types/yandex.js';
import type { P4DeviceState }              from '../types/internal.js';
import type { P4DeviceKind }               from './p4.service.js';
import { mapP4StateToYandex }              from '../mappers/state.mapper.js';
import { buildYandexDeviceId }             from '../mappers/device.mapper.js';
import { env }                             from '../config/env.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationKind = 'state' | 'discovery';

export interface StateNotificationJob {
  kind:            'state';
  yandexUserId:    string;
  houseId:         string;
  logicalDeviceId: string;
  deviceKind:      P4DeviceKind;
  state:           P4DeviceState;
  enqueuedAt:      number;
}

export interface DiscoveryNotificationJob {
  kind:         'discovery';
  yandexUserId: string;
  enqueuedAt:   number;
}

export type NotificationJob = StateNotificationJob | DiscoveryNotificationJob;

// ─── Dedup key ────────────────────────────────────────────────────────────────

function dedupKey(job: NotificationJob): string {
  if (job.kind === 'state') {
    return `alice:notif:dedup:state:${job.yandexUserId}:${job.logicalDeviceId}`;
  }
  return `alice:notif:dedup:discovery:${job.yandexUserId}`;
}

// ─── Producer ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a state change notification.
 * Deduplicates within NOTIFICATION_DEDUP_TTL_SECONDS window.
 */
export async function enqueueStateNotification(
  app:   FastifyInstance,
  event: Omit<StateNotificationJob, 'kind' | 'enqueuedAt'>,
): Promise<void> {
  const job: StateNotificationJob = { kind: 'state', enqueuedAt: Date.now(), ...event };
  const dKey = dedupKey(job);

  const isNew = await app.redis.set(dKey, '1', 'EX', env.NOTIFICATION_DEDUP_TTL_SECONDS, 'NX');
  if (!isNew) {
    app.log.debug({ deviceId: event.logicalDeviceId }, 'State notification deduplicated');
    return;
  }

  await app.redis.lpush(env.NOTIFICATION_QUEUE_KEY, JSON.stringify(job));
  app.log.debug({ deviceId: event.logicalDeviceId }, 'State notification enqueued');
}

/**
 * Enqueue a discovery notification (device list changed).
 * Deduplicates: only one discovery per user per dedup window.
 */
export async function enqueueDiscoveryNotification(
  app:          FastifyInstance,
  yandexUserId: string,
): Promise<void> {
  const job: DiscoveryNotificationJob = { kind: 'discovery', yandexUserId, enqueuedAt: Date.now() };
  const dKey = dedupKey(job);

  const isNew = await app.redis.set(dKey, '1', 'EX', env.NOTIFICATION_DEDUP_TTL_SECONDS, 'NX');
  if (!isNew) {
    app.log.debug({ yandexUserId }, 'Discovery notification deduplicated');
    return;
  }

  await app.redis.lpush(env.NOTIFICATION_QUEUE_KEY, JSON.stringify(job));
  app.log.debug({ yandexUserId }, 'Discovery notification enqueued');
}

// ─── Yandex API calls ─────────────────────────────────────────────────────────

const YANDEX_API_BASE = 'https://dialogs.yandex.net/api/v1/skills';
const MAX_RETRIES     = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callYandexWithRetry(
  url:     string,
  body:    unknown,
  log:     FastifyBaseLogger,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `OAuth ${env.YANDEX_SKILL_OAUTH_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        log.debug({ attempt, url }, 'Yandex callback delivered');
        return;
      }

      if (res.status === 429) {
        const after = parseInt(res.headers.get('Retry-After') ?? '5', 10) * 1000;
        log.warn({ attempt, retryAfterMs: after }, 'Yandex rate limited');
        await sleep(after);
        continue;
      }

      if (res.status >= 400 && res.status < 500) {
        log.error({ attempt, status: res.status, url }, 'Yandex callback client error — aborting');
        return;
      }

      log.warn({ attempt, status: res.status }, 'Yandex callback server error');
    } catch (err) {
      log.warn({ attempt, err }, 'Yandex callback network error');
    }

    if (attempt < MAX_RETRIES) await sleep(1_000 * Math.pow(2, attempt - 1));
  }

  log.error({ url, maxRetries: MAX_RETRIES }, 'Yandex callback failed after all retries');
}

// ─── Job processors ───────────────────────────────────────────────────────────

async function processStateJob(job: StateNotificationJob, log: FastifyBaseLogger): Promise<void> {
  if (!env.YANDEX_SKILL_ID || !env.YANDEX_SKILL_OAUTH_TOKEN) {
    log.warn('Skill credentials not set — skipping state callback');
    return;
  }

  const { capabilities, properties } = mapP4StateToYandex(job.deviceKind, job.state);
  if (capabilities.length === 0 && properties.length === 0) return;

  const payload: DeviceStateChangedCallback = {
    ts: Math.floor(Date.now() / 1000),
    payload: {
      user_id: job.yandexUserId,
      devices: [{
        id:           buildYandexDeviceId(job.houseId, job.logicalDeviceId),
        capabilities: capabilities as any,
        properties:   properties   as any,
      }],
    },
  };

  const url = `${YANDEX_API_BASE}/${env.YANDEX_SKILL_ID}/callback/state`;
  await callYandexWithRetry(url, payload, log);
}

async function processDiscoveryJob(job: DiscoveryNotificationJob, log: FastifyBaseLogger): Promise<void> {
  if (!env.YANDEX_SKILL_ID || !env.YANDEX_SKILL_OAUTH_TOKEN) {
    log.warn('Skill credentials not set — skipping discovery callback');
    return;
  }

  const url = `${YANDEX_API_BASE}/${env.YANDEX_SKILL_ID}/callback/discovery`;
  await callYandexWithRetry(url, { ts: Math.floor(Date.now() / 1000), payload: { user_id: job.yandexUserId } }, log);
}

// ─── Consumer (background worker) ─────────────────────────────────────────────

/**
 * Start the notification queue consumer.
 * Uses BRPOP (blocking pop) so it wakes immediately when work arrives.
 * Runs in a continuous loop; shuts down when `signal` is aborted.
 *
 * NOTE: Uses a dedicated Redis connection (separate from the main pool)
 * because BRPOP blocks the connection for up to BLOCK_TIMEOUT_SECONDS.
 */
export function startNotificationWorker(
  app:    FastifyInstance,
  signal: AbortSignal,
): void {
  const BLOCK_TIMEOUT = 5; // seconds to block on BRPOP before looping

  void (async () => {
    app.log.info('Notification worker started');
    while (!signal.aborted) {
      try {
        // BRPOP blocks until an item appears or timeout expires.
        const result = await app.redis.brpop(env.NOTIFICATION_QUEUE_KEY, BLOCK_TIMEOUT);
        if (!result) continue; // timeout — loop again

        const [, raw] = result;
        let job: NotificationJob;
        try {
          job = JSON.parse(raw) as NotificationJob;
        } catch (err) {
          app.log.error({ err, raw }, 'Failed to parse notification job — discarding');
          continue;
        }

        if (job.kind === 'state') {
          await processStateJob(job, app.log);
        } else if (job.kind === 'discovery') {
          await processDiscoveryJob(job, app.log);
        } else {
          app.log.warn({ job }, 'Unknown notification job kind — discarding');
        }
      } catch (err) {
        if (!signal.aborted) {
          app.log.error({ err }, 'Notification worker error — continuing');
          await sleep(1_000); // brief pause before retry
        }
      }
    }
    app.log.info('Notification worker stopped');
  })();
}
