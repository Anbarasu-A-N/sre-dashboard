#!/usr/bin/env node
'use strict';

// Recovery tool: set a user's password straight in the database.
//
//   node scripts/reset-password.js <username> [new-password] [--create]
//
// - new-password defaults to "admin123"; the account is flagged so the dashboard
//   asks for a new password at the next sign-in.
// - --create makes the user (as a super user) if it does not exist yet.
// - Run it as the same user that runs the server (e.g. with sudo if you start the
//   server with sudo) and with the same DATA_DIR, so the database files stay yours.
// - Safe to run while the server is up. The user is signed out everywhere.

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const create = process.argv.includes('--create');
const [rawName, rawPassword] = args;

if (!rawName) {
  console.error('Usage: node scripts/reset-password.js <username> [new-password] [--create]');
  process.exit(2);
}

(async () => {
  const config = require('../lib/config');
  const v = require('../lib/validation');
  const auth = require('../lib/auth');
  const store = require('../lib/store');
  const { DATA_DIR } = require('../lib/db');

  const username = v.username(rawName);
  const password = v.password(rawPassword || config.DEFAULT_ADMIN_PASSWORD);
  const hash = await auth.hashPassword(password);
  const existing = store.getUserByUsername(username);

  if (existing) {
    store.setUserPasswordHash(existing.id, hash, true);
    auth.destroyUserSessions(existing.id);
    console.log(`Password for "${username}" reset (database: ${DATA_DIR}). Sign in, then change it.`);
  } else if (create) {
    store.createUser({ username, password_hash: hash, role: 'superuser', must_change: true });
    console.log(`Created super user "${username}" (database: ${DATA_DIR}). Sign in, then change the password.`);
  } else {
    console.error(`No user "${username}" in ${DATA_DIR}. Use --create to create it.`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
