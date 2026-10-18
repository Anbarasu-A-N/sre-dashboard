'use strict';

const h = require('./helpers');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// This is the database your EC2 box has right now: schema version 2 (login + take/assign + links),
// old SEV1-4 severities, mode "open", one real user.
const hashOf = (password) => {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${crypto.scryptSync(password, salt, 64).toString('base64')}`;
};

function plantV2Database() {
  const db = new DatabaseSync(path.join(h.dataDir, 'dashboard.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'SEV3', status TEXT NOT NULL DEFAULT 'Ongoing',
      created_by TEXT NOT NULL, assignee TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      closed_at TEXT, mode TEXT NOT NULL DEFAULT 'open', links TEXT NOT NULL DEFAULT '[]', uid TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      label TEXT NOT NULL, event_time TEXT NOT NULL, note TEXT DEFAULT '', created_by TEXT NOT NULL,
      sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_events_incident ON events(incident_id);
    CREATE INDEX idx_incidents_status ON incidents(status);
    CREATE UNIQUE INDEX idx_incidents_uid ON incidents(uid);
    CREATE INDEX idx_incidents_assignee ON incidents(assignee);
    CREATE INDEX idx_incidents_severity ON incidents(severity);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
  `);
  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
    .run('admin', hashOf('AdminPass123'), 'superuser', '2026-10-15T10:00:00.000Z');
  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
    .run('bob', hashOf('bob-password-1'), 'user', '2026-10-15T10:05:00.000Z');

  const ins = db.prepare('INSERT INTO incidents (title, description, severity, status, created_by, assignee, created_at, updated_at, closed_at, mode, links, uid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('Old open alert', '', 'SEV2', 'Ongoing', 'admin', 'bob', '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z', null, 'open', '[{"name":"Grafana","url":"https://g.example.com/"}]', 'uid-1');
  ins.run('Old private alert', '', 'SEV4', 'Monitoring', 'admin', 'admin', '2026-10-09T10:00:00.000Z', '2026-10-09T11:00:00.000Z', null, 'private', '[]', 'uid-2');
  ins.run('Old done alert', '', 'SEV1', 'Completed', 'bob', '', '2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z', 'open', '[]', 'uid-3');
  db.prepare('INSERT INTO events (incident_id, label, event_time, note, created_by, sort_order, created_at, links) VALUES (?,?,?,?,?,?,?,?)')
    .run(1, 'Issue Occurred', '2026-10-10T09:55:00.000Z', 'it broke', 'admin', 0, '2026-10-10T10:00:00.000Z', '[{"name":"Graph","url":"https://g.example.com/1"}]');
  db.close();
}

let app;
let admin;

before(async () => {
  plantV2Database();
  app = await h.boot();            // opening the DB runs migration 3
  admin = app.client();
  await admin.login('admin', 'AdminPass123');
});
after(async () => { await app.close(); });

describe('upgrading a v2 database (what is on EC2 today) to v3', () => {
  test('data, links, users and passwords all survive', async () => {
    const list = (await admin.get('/api/incidents')).data;
    assert.equal(list.length, 3);
    const first = (await admin.get('/api/incidents/1')).data;
    assert.equal(first.title, 'Old open alert');
    assert.equal(first.assignee, 'bob');
    assert.equal(first.links[0].name, 'Grafana');
    assert.equal(first.events[0].links[0].name, 'Graph');

    const bob = app.client();
    const login = await bob.login('bob', 'bob-password-1');     // the old password hash still works
    assert.equal(login.data.user.mustChangePassword, false);     // existing users are not nagged
    assert.equal((await admin.get('/api/auth/me')).data.user.mustChangePassword, false);
  });

  test('severities are renamed and "open" becomes "assigned to anyone"; private stays private', async () => {
    const sev = (id) => admin.get(`/api/incidents/${id}`).then((r) => [r.data.severity, r.data.mode]);
    assert.deepEqual(await sev(1), ['Critical', 'anyone']);        // SEV2, open
    assert.deepEqual(await sev(2), ['Error', 'private']);          // SEV4, private
    assert.deepEqual(await sev(3), ['Show-stopper', 'anyone']);    // SEV1, open
    const dash = (await admin.get('/api/dashboard')).data;
    assert.deepEqual(dash.severity.map((s) => [s.severity, s.total]), [['Show-stopper', 1], ['Critical', 1], ['High', 0], ['Error', 1]]);
  });

  test('upgrading does not instantly put old alerts On Hold (3-day grace from the upgrade)', async () => {
    const store = require('../lib/store');
    assert.equal(store.autoHoldStale(), 0);
    const first = (await admin.get('/api/incidents/1')).data;
    assert.equal(first.status, 'Ongoing');
    assert.ok(Date.now() - Date.parse(first.last_update_at) < 60000);
    assert.deepEqual(first.activity, []);
    // ...but they do go on hold if nothing happens for 3 days after that
    assert.equal(store.autoHoldStale({ now: Date.now() + 3 * 86400000 + 60000 }), 1); // only the Ongoing one
    assert.equal((await admin.get('/api/incidents/2')).data.status, 'Monitoring');
    assert.equal((await admin.get('/api/incidents/3')).data.status, 'Completed');
  });

  test('new alerts work on the upgraded database, and the schema is at v3', async () => {
    const r = await admin.post('/api/incidents', { title: 'After upgrade', severity: 'High' });
    assert.equal(r.status, 201);
    assert.equal(r.data.mode, 'takecare');
    const { db } = require('../lib/db');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  });
});
