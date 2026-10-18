'use strict';

// Zero-dependency storage on Node's built-in SQLite (node:sqlite).
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'dashboard.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumn(table, name, ddl) {
  if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

// Each migration runs once, in order, inside a transaction.
// NEVER edit an old migration after release; add a new one.
const MIGRATIONS = [
  // 1: original schema (shipped in v1). Idempotent so pre-versioning databases adopt it.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        severity TEXT NOT NULL DEFAULT 'SEV3',
        status TEXT NOT NULL DEFAULT 'Ongoing',
        created_by TEXT NOT NULL,
        owner TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        event_time TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_incident ON events(incident_id);
      CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
    `);
  },

  // 2: users/sessions, assignment + collaboration mode, links, stable uid for imports
  () => {
    if (columns('incidents').includes('owner') && !columns('incidents').includes('assignee')) {
      db.exec('ALTER TABLE incidents RENAME COLUMN owner TO assignee');
    }
    addColumn('incidents', 'mode', "TEXT NOT NULL DEFAULT 'open'");
    addColumn('incidents', 'links', "TEXT NOT NULL DEFAULT '[]'");
    addColumn('incidents', 'uid', 'TEXT');
    addColumn('events', 'links', "TEXT NOT NULL DEFAULT '[]'");

    const missing = db.prepare('SELECT id FROM incidents WHERE uid IS NULL').all();
    const setUid = db.prepare('UPDATE incidents SET uid = ? WHERE id = ?');
    for (const row of missing) setUid.run(crypto.randomUUID(), row.id);

    db.exec(`
      UPDATE incidents SET assignee = '' WHERE assignee IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_uid ON incidents(uid);
      CREATE INDEX IF NOT EXISTS idx_incidents_assignee ON incidents(assignee);
      CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
  },

  // 3: severity names, take-care mode, automatic On Hold, timeline activity, password-change flag
  () => {
    addColumn('incidents', 'last_update_at', 'TEXT');
    // Existing alerts get a fresh 3-day grace period instead of being put On Hold the moment you upgrade.
    db.prepare('UPDATE incidents SET last_update_at = ? WHERE last_update_at IS NULL').run(new Date().toISOString());

    db.exec(`
      UPDATE incidents SET severity = CASE severity
        WHEN 'SEV1' THEN 'Show-stopper' WHEN 'SEV2' THEN 'Critical'
        WHEN 'SEV3' THEN 'High' WHEN 'SEV4' THEN 'Error' ELSE severity END;
      UPDATE incidents SET mode = 'anyone' WHERE mode = 'open';
    `);

    addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_incident ON activity(incident_id);
      CREATE INDEX IF NOT EXISTS idx_incidents_last_update ON incidents(status, last_update_at);
    `);
  },

  // 4: take care is separate from assignment ("carers"), notifications, manual vs automatic On Hold
  () => {
    addColumn('incidents', 'hold_auto', 'INTEGER NOT NULL DEFAULT 0');
    // Before this version nobody could put an alert On Hold by hand, so every existing hold was automatic.
    db.exec("UPDATE incidents SET hold_auto = 1 WHERE status = 'On Hold'");

    db.exec(`
      CREATE TABLE IF NOT EXISTS carers (
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (incident_id, username)
      );
      CREATE INDEX IF NOT EXISTS idx_carers_user ON carers(username);

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
    `);
  },

  // 5: alerts created in take-care mode with nobody assigned have ONE holder at a time
  () => {
    addColumn('incidents', 'single_holder', 'INTEGER NOT NULL DEFAULT 0');
  },
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v]();
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration to v${v + 1} failed: ${err.message}`);
    }
  }
}

// Run fn inside a transaction; rolls back if it throws.
function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migrate();

module.exports = { db, tx, DATA_DIR };
