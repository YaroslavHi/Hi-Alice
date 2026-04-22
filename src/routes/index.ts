import type { FastifyInstance } from 'fastify';
import { registerHealthRoutes }    from '../controllers/health.controller.js';
import { registerOAuthRoutes }     from '../controllers/oauth.controller.js';
import { registerUnlinkRoutes }    from '../controllers/unlink.controller.js';
import { registerDiscoveryRoutes } from '../controllers/discovery.controller.js';
import { registerQueryRoutes }     from '../controllers/query.controller.js';
import { registerActionRoutes }    from '../controllers/action.controller.js';
import { registerP4WebhookRoutes } from '../controllers/p4-webhook.controller.js';
import { registerMetricsRoutes }   from '../controllers/metrics.controller.js';
import { registerAdminRoutes }     from '../controllers/admin.controller.js';
import { registerLoginRoutes }     from '../controllers/login.controller.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerHealthRoutes(app);    // GET|HEAD /v1.0
  await registerOAuthRoutes(app);     // /oauth/*
  await registerLoginRoutes(app);     // GET|POST /login
  await registerDiscoveryRoutes(app); // A3: GET  /v1.0/user/devices
  await registerQueryRoutes(app);     // A4: POST /v1.0/user/devices/query
  await registerActionRoutes(app);    // A4: POST /v1.0/user/devices/action
  await registerUnlinkRoutes(app);    // A2: POST /v1.0/user/unlink
  await registerP4WebhookRoutes(app); // A5: POST /internal/p4/*
  await registerMetricsRoutes(app);   // A7: GET  /metrics
  await registerAdminRoutes(app);     // Admin: /admin/v1/*
}
