#!/usr/bin/env node
/**
 * Generates all secrets needed for a fresh alice-adapter deployment.
 * Run once per server, save output to .env.
 *
 * Usage: node scripts/generate-keys.js
 */

const crypto = require('crypto');

const keys = {
  TOKEN_ENCRYPTION_KEY:        crypto.randomBytes(32).toString('hex'),
  TOKEN_HMAC_KEY:              crypto.randomBytes(32).toString('hex'),
  POSTGRES_PASSWORD:           crypto.randomBytes(20).toString('hex'),
  P4_RELAY_TOKEN:              crypto.randomBytes(24).toString('hex'),
  NODE_RED_CREDENTIAL_SECRET:  crypto.randomBytes(32).toString('hex'),
};

console.log('\n# Generated secrets — add to .env\n');
for (const [key, val] of Object.entries(keys)) {
  console.log(`${key}=${val}`);
}
console.log('\n# IMPORTANT: keep these values secret and never commit to git\n');
