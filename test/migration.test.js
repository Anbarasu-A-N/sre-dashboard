'use strict';

const h = require('./helpers');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Exactly the schema + data shape the v1 app (no login, "owner" column) produced.
function plantLegacyDatabase() {
  const legacy = new DatabaseSync(path.join(h.dataDir, 'dashboard.db'));
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE incidents (
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
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      event_time TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_by TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_events_incident ON events(incident_id);
    CREATE INDEX idx_incidents_status ON incidents(status);
  `);
  const ins = legacy.prepare('INSERT INTO incidents (title, description, severity, status, created_by, owner, created_at, updated_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('Payment API 5xx spike', 'checkout errors', 'SEV1', 'Ongoing', 'Alice Smith', 'Alice Smith', '2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', null);
  ins.run('DB replica lag', '', 'SEV2', 'Completed', 'bob', '', '2026-10-02T10:00:00.000Z', '2026-10-02T11:00:00.000Z', '2026-10-02T11:00:00.000Z');
  const ev = legacy.prepare('INSERT INTO events (incident_id, label, event_time, note, created_by, sort_order, created_at) VALUES (?,?,?,?,?,?,?)');
  ev.run(1, 'Issue Occurred', '2026-10-01T09:58:00.000Z', '5xx threshold crossed', 'Alice Smith', 0, '2026-10-01T10:01:00.000Z');
  ev.run(1, 'Identified', '2026-10-01T10:06:00.000Z', 'bad deploy', 'Alice Smith', 1, '2026-10-01T10:07:00.000Z');
  ev.run(1, 'My custom label', '2026-10-01T11:00:00.000Z', '', 'bob', 2, '2026-10-01T11:00:00.000Z');
  legacy.close();
}

let app;
let admin;

before(async () => {
  plantLegacyDatabase();
  app = await h.boot(); // opening the DB runs the migrations
  admin = app.client();
  await admin.login('admin', h.ADMIN_PASSWORD);
});

after(async () => { await app.close(); });

describe('upgrading a v1 database in place', () => {
  test('existing alerts and timelines survive untouched', async () => {
    const list = (await admin.get('/api/incidents')).data;
    assert.equal(list.length, 2);

    const first = (await admin.get('/api/incidents/1')).data;
    assert.equal(first.title, 'Payment API 5xx spike');
    assert.equal(first.severity, 'Show-stopper'); // SEV1 was renamed
    assert.equal(first.status, 'Ongoing');
    assert.equal(first.created_by, 'Alice Smith');
    assert.deepEqual(first.events.map((e) => e.label), ['Issue Occurred', 'Identified', 'My custom label']);
    assert.equal(first.events[0].note, '5xx threshold crossed');

    const second = (await admin.get('/api/incidents/2')).data;
    assert.equal(second.closed_at, '2026-10-02T11:00:00.000Z');
  });

  test('old "owner" becomes "assignee"; new columns get safe defaults', async () => {
    const first = (await admin.get('/api/incidents/1')).data;
    assert.equal(first.assignee, 'Alice Smith');
    assert.equal(first.mode, 'anyone');            // old "open" = assigned to anyone
    assert.deepEqual(first.links, []);
    assert.deepEqual(first.events[0].links, []);

    const second = (await admin.get('/api/incidents/2')).data;
    assert.equal(second.assignee, ''); // was unowned
  });

  test('every legacy alert is given a unique uid so imports can de-duplicate', async () => {
    const exported = (await admin.get('/api/export?scope=events')).data;
    const uids = exported.incidents.map((i) => i.uid);
    assert.equal(uids.length, 2);
    assert.ok(uids.every(Boolean));
    assert.equal(new Set(uids).size, 2);
  });

  test('legacy alerts keep working under the new permission rules', async () => {
    // Legacy creators were free text, so a user created later with a matching name inherits them.
    await admin.post('/api/users', { username: 'bob', password: 'bob-password-1' });
    const bob = app.client();
    await bob.login('bob', 'bob-password-1');
    const asBob = (await bob.get('/api/incidents/2')).data;
    assert.equal(asBob.permissions.canEdit, true);   // bob created it
    assert.equal(asBob.permissions.canDelete, true);
    const other = (await bob.get('/api/incidents/1')).data;
    assert.equal(other.permissions.canEdit, false);   // "Alice Smith" is not bob

    // unowned + completed => cannot assign to yourself; reopen it and it becomes possible
    assert.equal(asBob.permissions.canAssignSelf, false);
    await bob.patch('/api/incidents/2', { status: 'Ongoing' });
    assert.equal((await bob.get('/api/incidents/2')).data.permissions.canAssignSelf, true);
  });

  test('the schema version is recorded and re-opening is a no-op', async () => {
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e',
      "const {db}=require('./lib/db');console.log(db.prepare('PRAGMA user_version').get().user_version, db.prepare('SELECT COUNT(*) c FROM incidents').get().c)"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: h.dataDir }, encoding: 'utf8' });
    assert.equal(out.trim(), '5 2');
  });
});
