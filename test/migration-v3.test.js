'use strict';

const h = require('./helpers');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// The database an instance of the previous release has: schema v3 (take care made you the assignee,
// On Hold was automatic-only, no carers, no notifications).
const hashOf = (password) => {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${crypto.scryptSync(password, salt, 64).toString('base64')}`;
};
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

function plantV3Database() {
  const db = new DatabaseSync(path.join(h.dataDir, 'dashboard.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'SEV3', status TEXT NOT NULL DEFAULT 'Ongoing',
      created_by TEXT NOT NULL, assignee TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      closed_at TEXT, mode TEXT NOT NULL DEFAULT 'open', links TEXT NOT NULL DEFAULT '[]', uid TEXT,
      last_update_at TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      label TEXT NOT NULL, event_time TEXT NOT NULL, note TEXT DEFAULT '', created_by TEXT NOT NULL,
      sort_order INTEGER NOT NULL, created_at TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_events_incident ON events(incident_id);
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
    PRAGMA user_version = 3;
  `);
  const user = db.prepare('INSERT INTO users (username, password_hash, role, created_at, must_change_password) VALUES (?,?,?,?,?)');
  user.run('admin', hashOf('AdminPass123'), 'superuser', ago(5), 0);
  user.run('alice', hashOf('alice-password-1'), 'user', ago(5), 0);
  user.run('bob', hashOf('bob-password-1'), 'user', ago(5), 1);

  const inc = db.prepare('INSERT INTO incidents (title, severity, status, created_by, assignee, created_at, updated_at, closed_at, mode, uid, last_update_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  inc.run('Held automatically', 'High', 'On Hold', 'alice', 'alice', ago(6), ago(1), null, 'takecare', 'uid-1', ago(4));
  inc.run('Bob took this over', 'Critical', 'Ongoing', 'alice', 'bob', ago(2), ago(1), null, 'takecare', 'uid-2', ago(1));
  inc.run('Anyone mode', 'Error', 'Monitoring', 'alice', '', ago(3), ago(2), null, 'anyone', 'uid-3', ago(2));
  inc.run('Finished', 'Show-stopper', 'Completed', 'bob', 'bob', ago(4), ago(3), ago(3), 'takecare', 'uid-4', ago(3));
  const act = db.prepare('INSERT INTO activity (incident_id, kind, actor, text, created_at) VALUES (?,?,?,?,?)');
  act.run(2, 'created', 'alice', 'alice created this alert and is taking care of it', ago(2));
  act.run(2, 'took_care', 'bob', 'bob took care of this alert (was alice)', ago(1));
  act.run(1, 'auto_hold', 'system', 'Automatically moved to On Hold: no timeline update for 3 days', ago(1));
  db.close();
}

let app;
let admin;
before(async () => {
  plantV3Database();
  app = await h.boot();
  admin = app.client();
  await admin.login('admin', 'AdminPass123');
});
after(async () => { await app.close(); });

describe('upgrading a v3 database (the previous release) to the current schema', () => {
  test('everything is kept: alerts, people-written history, who is assigned, passwords', async () => {
    const list = (await admin.get('/api/incidents')).data;
    assert.equal(list.length, 4);
    const taken = (await admin.get('/api/incidents/2')).data;
    assert.equal(taken.assignee, 'bob');                       // the old "take care" assignment is preserved as an assignment
    assert.deepEqual(taken.activity.map((a) => a.kind), ['created', 'took_care']);
    assert.deepEqual(taken.carers, []);

    const bob = app.client();
    const login = await bob.login('bob', 'bob-password-1');
    assert.equal(login.data.user.mustChangePassword, true);    // flags carry over
    assert.equal((await admin.get('/api/auth/me')).data.user.mustChangePassword, false);
  });

  test('every existing On Hold alert is marked as automatic (manual holds did not exist yet)', async () => {
    const held = (await admin.get('/api/incidents/1')).data;
    assert.equal(held.status, 'On Hold');
    assert.equal(held.hold_auto, 1);
    for (const id of [2, 3, 4]) assert.equal((await admin.get(`/api/incidents/${id}`)).data.hold_auto, 0);

    // and, being automatic, it resumes when someone adds an update, exactly as before
    await admin.post('/api/incidents/1/events', { label: 'Update', event_time: new Date().toISOString() });
    assert.equal((await admin.get('/api/incidents/1')).data.status, 'Ongoing');
  });

  test('the new tables exist, start empty, and the schema is at v5', async () => {
    const { db } = require('../lib/db');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM carers').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications').get().c, 0);
  });

  test('new behaviour works on the upgraded data: take care, notifications, my alerts', async () => {
    const carol = (await admin.post('/api/users', { username: 'carol', password: 'carol-password-1' })).data;
    assert.ok(carol.id);
    const c = app.client();
    await c.login('carol', 'carol-password-1');

    const took = await c.post('/api/incidents/2/care');                  // an old alert assigned to bob
    assert.equal(took.status, 200);
    assert.deepEqual(took.data.carers, ['carol']);
    assert.equal(took.data.assignee, 'bob');
    assert.equal((await c.post('/api/incidents/2/events', { label: 'Update', event_time: new Date().toISOString() })).status, 201);

    const bob = app.client();
    await bob.login('bob', 'bob-password-1');
    const created = (await admin.post('/api/incidents', { title: 'New after upgrade', severity: 'High' })).data;
    const inbox = (await bob.get('/api/notifications')).data;
    assert.equal(inbox.unread, 1);
    assert.equal(inbox.items[0].incident_id, created.id);

    const mine = (await c.get('/api/incidents?mine=1')).data;
    assert.deepEqual(mine.map((r) => [r.id, r.mine_kind]), [[2, 'care']]);
  });

  test('upgrading does not put anything On Hold by itself', async () => {
    const store = require('../lib/store');
    assert.equal(store.autoHoldStale(), 0);
  });
});
