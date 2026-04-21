/**
 * @module db/client
 *
 * PostgreSQL client — Fastify plugin wrapping `postgres` (sql-template-tag based).
 * Registered as a singleton on the Fastify instance.
 */

import fp from 'fastify-plugin';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

export type Sql = postgres.Sql;

declare module 'fastify' {
  interface FastifyInstance {
    pg: Sql;
  }
}

async function dbPlugin(app: FastifyInstance): Promise<void> {
  const sql = postgres(env.DATABASE_URL, {
    max:           10,
    idle_timeout:  30,
    connect_timeout: 10,
    transform:     postgres.camel, // snake_case → camelCase
    onnotice:      (notice) => {
      app.log.debug({ notice }, 'postgres notice');
    },
  });

  // Verify connection at startup — fail fast rather than at first request.
  try {
    await sql`SELECT 1`;
    app.log.info('PostgreSQL connection established');
  } catch (err) {
    app.log.error({ err }, 'PostgreSQL connection failed');
    throw err;
  }

  app.decorate('pg', sql);

  app.addHook('onClose', async () => {
    app.log.info('Closing PostgreSQL connection pool');
    await sql.end({ timeout: 5 });
  });
}

export default fp(dbPlugin, {
  name: 'db',
  fastify: '4.x',
});
