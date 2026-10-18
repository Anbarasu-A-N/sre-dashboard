'use strict';

const h = require('./helpers');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// The database the previous release has: schema v4 (take care = events only, carers, notifications,
// manual + automatic On Hold) but no one-holder rule yet.
const hashOf = (password) => {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${crypto.scryptSync(password, salt, 64).toString('base64')}`;
};
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

function plantV4Database() {
  const db = new DatabaseSync(path.join(h.dataDir, 'dashboard.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'SEV3', status TEXT NOT NULL DEFAULT 'Ongoing',
      created_by TEXT NOT NULL, assignee TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      closed_at TEXT, mode TEXT NOT NULL DEFAULT 'open', links TEXT NOT NULL DEFAULT '[]', uid TEXT,
      last_update_at TEXT, hold_auto INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      label TEXT NOT NULL, event_time TEXT NOT NULL, note TEXT DEFAULT '', created_by TEXT NOT NULL,
      sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX idx_incidents_uid ON incidents(uid);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE carers (
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      username TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (incident_id, username)
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
    );
    PRAGMA user_version = 4;
  `);
  const user = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)');
  user.run('admin', hashOf('AdminPass123'), 'superuser', ago(9));
  for (const n of ['alice', 'bob', 'carol']) user.run(n, hashOf(`${n}-password-1`), 'user', ago(9));

  const inc = db.prepare('INSERT INTO incidents (title, severity, status, created_by, assignee, created_at, updated_at, mode, uid, last_update_at, hold_auto) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  inc.run('Two carers already', 'High', 'Ongoing', 'alice', 'alice', ago(2), ago(1), 'takecare', 'uid-1', ago(1), 0);
  inc.run('Unassigned take-care alert', 'Critical', 'Ongoing', 'alice', '', ago(2), ago(1), 'takecare', 'uid-2', ago(1), 0);
  inc.run('Manual hold', 'Error', 'On Hold', 'bob', 'bob', ago(5), ago(3), 'anyone', 'uid-3', ago(3), 0);
  const carer = db.prepare('INSERT INTO carers (incident_id, username, created_at) VALUES (?,?,?)');
  carer.run(1, 'bob', ago(1));
  carer.run(1, 'carol', ago(1));
  db.prepare('INSERT INTO notifications (user_id, incident_id, kind, text, created_at) VALUES (?,?,?,?,?)')
    .run(3, 1, 'takecare_alert', 'alice created "Two carers already" (High). Anyone can take care of it.', ago(2));
  db.close();
}

let app;
let admin;
before(async () => {
  plantV4Database();
  app = await h.boot();
  admin = app.client();
  await admin.login('admin', 'AdminPass123');
});
after(async () => { await app.close(); });

describe('upgrading a v4 database (the previous release) to the pickup rule', () => {
  test('everything is kept: carers, notifications, holds, assignments, passwords', async () => {
    const two = (await admin.get('/api/incidents/1')).data;
    assert.deepEqual(two.carers, ['bob', 'carol']);
    assert.equal(two.assignee, 'alice');
    assert.equal((await admin.get('/api/incidents/3')).data.status, 'On Hold');
    assert.equal((await admin.get('/api/incidents/3')).data.hold_auto, 0);

    const alice = app.client();
    await alice.login('alice', 'alice-password-1');
    assert.equal((await alice.get('/api/notifications')).data.unread, 0);
    const bob = app.client();
    await bob.login('bob', 'bob-password-1');
    assert.equal((await bob.get('/api/notifications')).data.unread, 1);
  });

  test('existing alerts are not open for pickup: they keep working as before', async () => {
    for (const id of [1, 2, 3]) assert.equal((await admin.get(`/api/incidents/${id}`)).data.single_holder, 0);

    const bob = app.client(); const carol = app.client(); const dave = (await admin.post('/api/users', { username: 'dave', password: 'dave-password-1' })).data;
    assert.ok(dave.id);
    await bob.login('bob', 'bob-password-1'); await carol.login('carol', 'carol-password-1');
    const d = app.client(); await d.login('dave', 'dave-password-1');

    // the unassigned take-care alert from before the upgrade still allows more than one carer
    assert.equal((await bob.post('/api/incidents/2/care')).status, 200);
    assert.equal((await carol.post('/api/incidents/2/care')).status, 200);
    assert.deepEqual((await admin.get('/api/incidents/2')).data.carers, ['bob', 'carol']);
    // and a third carer on the one that already had two
    assert.equal((await d.post('/api/incidents/1/care')).status, 200);
    assert.equal((await d.get('/api/incidents/2')).data.permissions.canAssignSelf, false); // it is not a single-holder alert
  });

  test('new alerts created with nobody assigned are open for pickup', async () => {
    const created = (await admin.post('/api/incidents', { title: 'Fresh, nobody assigned', assignee: '', severity: 'High' })).data;
    assert.equal(created.single_holder, 1);
    const bob = app.client(); await bob.login('bob', 'bob-password-1');
    const carol = app.client(); await carol.login('carol', 'carol-password-1');
    assert.equal((await bob.post(`/api/incidents/${created.id}/care`)).status, 200);
    assert.equal((await carol.post(`/api/incidents/${created.id}/care`)).status, 200);          // taking care is shared
    assert.equal((await carol.post(`/api/incidents/${created.id}/assign`, { assignee: 'carol' })).status, 200);  // and Assign to me is offered
    assert.equal((await bob.post(`/api/incidents/${created.id}/assign`, { assignee: 'bob' })).status, 403);     // ...but locks once taken
  });

  test('the schema is at v5 and nothing was put On Hold by the upgrade', async () => {
    const { db } = require('../lib/db');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(require('../lib/store').autoHoldStale(), 0);
  });
});
