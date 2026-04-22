/**
 * Node-RED settings for HI Alice Adapter — P4 relay bridge.
 *
 * Copy this file to /data/settings.js inside the Node-RED container,
 * or mount it read-only (see docker-compose.nodered.yml).
 *
 * Required: set credentialSecret to a strong random string so MQTT
 * broker credentials are stored encrypted. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

module.exports = {

  // Path to the flows file (relative to userDir = /data)
  flowFile: 'flows.json',

  // Credential encryption key.
  // REQUIRED — set this before first start. Do NOT change after deploying
  // (changing it loses all stored credentials).
  // Can also be set via NODE_RED_CREDENTIAL_SECRET environment variable.
  credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || 'CHANGE_ME_TO_A_RANDOM_64_HEX_STRING',

  // Pretty-print flows.json for easier git diffs
  flowFilePretty: true,

  // Editor theme
  editorTheme: {
    projects: {
      enabled: false,
    },
  },

  // Logging
  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false,
    },
  },

};
