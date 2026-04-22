/**
 * @module plugins/metrics
 *
 * Lightweight Prometheus-compatible metrics for the alice-adapter.
 * Exposed on GET /metrics (plain text, Prometheus format).
 *
 * A7 requirement: JSON logs + metrics + correlation_id tracing.
 *
 * Tracked:
 *   alice_http_requests_total{method, route, status}  — request counts
 *   alice_http_duration_ms{route}                     — latency histogram buckets
 *   alice_token_validations_total{result}             — auth outcomes
 *   alice_p4_relay_calls_total{endpoint, status}      — relay call outcomes
 *   alice_notifications_enqueued_total{kind}          — queued notifications
 *   alice_notifications_delivered_total{kind, result} — delivery outcomes
 *   alice_oauth_events_total{event}                   — token_issued, unlinked, etc.
 *
 * NOTE: Uses in-process counters (Map + atomic reads).
 *       For multi-process / multi-pod deployments, push to a push-gateway
 *       or use Redis-backed counters. Single-pod is the initial target.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ─── Metric stores ────────────────────────────────────────────────────────────

type Labels = Record<string, string>;
type MetricMap = Map<string, number>;

const counters:   MetricMap = new Map();
const histograms: Map<string, number[]> = new Map();

function labelKey(name: string, labels: Labels): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',');
  return parts ? `${name}{${parts}}` : name;
}

export function incCounter(name: string, labels: Labels = {}): void {
  const key = labelKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

const HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export function observeHistogram(name: string, valueMs: number, labels: Labels = {}): void {
  const key = labelKey(name, labels);
  if (!histograms.has(key)) histograms.set(key, []);
  histograms.get(key)!.push(valueMs);
}

// ─── Prometheus text serialiser ───────────────────────────────────────────────

function renderCounters(): string {
  const lines: string[] = [];
  for (const [key, val] of counters.entries()) {
    lines.push(`${key} ${val}`);
  }
  return lines.join('\n');
}

function renderHistograms(): string {
  const lines: string[] = [];
  for (const [key, values] of histograms.entries()) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum    = sorted.reduce((s, v) => s + v, 0);
    const count  = sorted.length;

    // Strip label suffix to get metric name for HELP/TYPE.
    const metricName = key.replace(/\{.*$/, '');
    lines.push(`# TYPE ${metricName} histogram`);

    for (const le of HISTOGRAM_BUCKETS) {
      const bucketKey = key ? key.replace(/\}$/, `,le="${le}"}`) : `{le="${le}"}`;
      const cnt = sorted.filter((v) => v <= le).length;
      lines.push(`${metricName}_bucket${bucketKey} ${cnt}`);
    }
    const infKey = key ? key.replace(/\}$/, `,le="+Inf"}`) : `{le="+Inf"}`;
    lines.push(`${metricName}_bucket${infKey} ${count}`);
    lines.push(`${metricName}_sum${key ? key.replace(/^[^{]+/, '') : ''} ${sum}`);
    lines.push(`${metricName}_count${key ? key.replace(/^[^{]+/, '') : ''} ${count}`);
  }
  return lines.join('\n');
}

export function renderMetrics(): string {
  return [
    '# HELP alice_http_requests_total Total HTTP requests',
    '# TYPE alice_http_requests_total counter',
    renderCounters(),
    renderHistograms(),
  ].filter(Boolean).join('\n') + '\n';
}

// ─── Fastify plugin ───────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      inc:     typeof incCounter;
      observe: typeof observeHistogram;
      render:  typeof renderMetrics;
    };
  }
}

async function metricsPlugin(app: FastifyInstance): Promise<void> {
  app.decorate('metrics', {
    inc:     incCounter,
    observe: observeHistogram,
    render:  renderMetrics,
  });

  // Instrument every request.
  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    const route  = request.routerPath ?? 'unknown';
    const method = request.method;
    const status = String(reply.statusCode);
    const elapsed = reply.elapsedTime;

    incCounter('alice_http_requests_total', { method, route, status });
    observeHistogram('alice_http_duration_ms', elapsed, { route });
    done();
  });
}

export default fp(metricsPlugin, { name: 'metrics', fastify: '4.x' });
