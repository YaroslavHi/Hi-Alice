/**
 * @module scripts/migrate
 *
 * Runs the SQL schema file against the configured PostgreSQL database.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS.
 *
 * Usage: npm run migrate
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  process.stderr.write('ERROR: DATABASE_URL is not set\n');
  process.exit(1);
}

const schemaPath = resolve(__dirname, '../src/db/schema.sql');
const schemaSql  = readFileSync(schemaPath, 'utf-8');

const sql = postgres(DATABASE_URL, { max: 1 });

async function migrate(): Promise<void> {
  process.stdout.write('Running migrations...\n');
  try {
    await sql.unsafe(schemaSql);
    process.stdout.write('Migrations completed successfully.\n');
  } catch (err) {
    process.stderr.write(`Migration failed: ${String(err)}\n`);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

migrate();
