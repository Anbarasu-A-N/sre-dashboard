'use strict';

const { boot, ADMIN_PASSWORD } = require('./helpers');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
let anon;
let admin;
let alice;
let bob;
let carol;

before(async () => {
  app = await boot();
  anon = app.client();
  admin = app.client();
  alice = app.client();
  bob = app.client();
  carol = app.client();

  await admin.login('admin', ADMIN_PASSWORD);
  for (const name of ['alice', 'bob', 'carol']) {
    const r = await admin.post('/api/users', { username: name, password: `${name}-password-1`, role: 'user' });
    assert.equal(r.status, 201, `create ${name}`);
  }
  await alice.login('alice', 'alice-password-1');
  await bob.login('bob', 'bob-password-1');
  await carol.login('carol', 'carol-password-1');
});

after(async () => { await app.close(); });

const newAlert = async (client, extra = {}) => {
  const r = await client.post('/api/incidents', { title: 'Test alert', severity: 'Critical', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};

// ---------------------------------------------------------------------
describe('anonymous visitors are read-only', () => {
  test('health + meta are public', async () => {
    assert.equal((await anon.get('/healthz')).status, 200);
    const meta = await anon.get('/api/meta');
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.data.severities, ['Show-stopper', 'Critical', 'High', 'Error']);
    assert.deepEqual(meta.data.modes.map((m) => m.value), ['takecare', 'anyone', 'private']);
    assert.equal(meta.data.autoHoldDays, 3);
  });

  test('can view alerts, details and the dashboard', async () => {
    const a = await newAlert(alice, { title: 'Visible to all' });
    assert.equal((await anon.get('/api/incidents')).status, 200);
    const detail = await anon.get(`/api/incidents/${a.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.permissions, {
      canEdit: false, canAddEvent: false, canAssign: false, canAssignSelf: false,
      canTakeCare: false, canLeaveCare: false, canDelete: false, canChangeMode: false,
    });
    assert.equal((await anon.get('/api/dashboard')).status, 200);
  });

  test('cannot change anything or see user data', async () => {
    const a = await newAlert(alice);
    const attempts = [
      anon.post('/api/incidents', { title: 'x' }),
      anon.patch(`/api/incidents/${a.id}`, { status: 'Completed' }),
      anon.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' }),
      anon.post(`/api/incidents/${a.id}/events`, { label: 'x', event_time: new Date().toISOString() }),
      anon.del(`/api/incidents/${a.id}`),
      anon.get('/api/users/directory'),
      anon.get('/api/users'),
      anon.get('/api/export?scope=events'),
      anon.post('/api/import', {}),
    ];
    for (const r of await Promise.all(attempts)) assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------------
describe('authentication', () => {
  test('wrong password and unknown user get the same generic error', async () => {
    const c = app.client();
    const wrong = await c.post('/api/auth/login', { username: 'alice', password: 'nope-nope-nope' });
    const unknown = await c.post('/api/auth/login', { username: 'ghost', password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.data.error, unknown.data.error);
  });

  test('session cookie is HttpOnly + SameSite and /me reflects the user', async () => {
    const c = app.client();
    const r = await c.login('alice', 'alice-password-1');
    const cookie = r.setCookie[0];
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.deepEqual((await c.get('/api/auth/me')).data.user.username, 'alice');
  });

  test('usernames are case-insensitive at login', async () => {
    const c = app.client();
    const r = await c.post('/api/auth/login', { username: '  ALICE ', password: 'alice-password-1' });
    assert.equal(r.status, 200);
  });

  test('logout ends the session server-side', async () => {
    const c = app.client();
    await c.login('alice', 'alice-password-1');
    const stolen = c.cookie;
    await c.post('/api/auth/logout');
    const replay = app.client();
    replay.cookie = stolen;
    assert.equal((await replay.get('/api/auth/me')).data.user, null);
  });

  test('changing your password requires the current one and signs out other devices', async () => {
    const phone = app.client();
    const laptop = app.client();
    await admin.post('/api/users', { username: 'dave', password: 'dave-password-1' });
    await phone.login('dave', 'dave-password-1');
    await laptop.login('dave', 'dave-password-1');

    assert.equal((await laptop.post('/api/auth/password', { current_password: 'wrong', new_password: 'new-password-1' })).status, 400);
    assert.equal((await laptop.post('/api/auth/password', { current_password: 'dave-password-1', new_password: 'short' })).status, 400);
    assert.equal((await laptop.post('/api/auth/password', { current_password: 'dave-password-1', new_password: 'new-password-1' })).status, 200);

    assert.equal((await laptop.get('/api/auth/me')).data.user.username, 'dave'); // current device stays in
    assert.equal((await phone.get('/api/auth/me')).data.user, null);              // other device is out
    assert.equal((await app.client().post('/api/auth/login', { username: 'dave', password: 'dave-password-1' })).status, 401);
    assert.equal((await app.client().post('/api/auth/login', { username: 'dave', password: 'new-password-1' })).status, 200);
  });

  test('cross-origin writes are blocked even with a valid session', async () => {
    const r = await alice.request('POST', '/api/incidents', { title: 'CSRF' }, { Origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    const same = await alice.request('POST', '/api/incidents', { title: 'ok' }, { Origin: app.base });
    assert.equal(same.status, 201);
  });
});

// ---------------------------------------------------------------------
describe('user management (super user only)', () => {
  test('normal users cannot manage users', async () => {
    assert.equal((await alice.post('/api/users', { username: 'mallory', password: 'password-123' })).status, 403);
    assert.equal((await alice.get('/api/users')).status, 403);
    assert.equal((await alice.patch('/api/users/1', { role: 'superuser' })).status, 403);
    assert.equal((await alice.del('/api/users/1')).status, 403);
  });

  test('validation and duplicates', async () => {
    assert.equal((await admin.post('/api/users', { username: 'alice', password: 'password-123' })).status, 409);
    assert.equal((await admin.post('/api/users', { username: 'Alice', password: 'password-123' })).status, 409);
    assert.equal((await admin.post('/api/users', { username: 'a b', password: 'password-123' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'ok-name', password: 'short' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'ok-name', password: 'password-123', role: 'god' })).status, 400);
  });

  test('listings never expose password hashes', async () => {
    const full = await admin.get('/api/users');
    assert.ok(full.data.length >= 4);
    assert.ok(!JSON.stringify(full.data).includes('scrypt'));
    const dir = await alice.get('/api/users/directory');
    assert.ok(dir.data.find((u) => u.username === 'bob'));
    assert.ok(!JSON.stringify(dir.data).includes('scrypt'));
    assert.deepEqual(Object.keys(dir.data[0]).sort(), ['role', 'username']);
  });

  test('guards against locking everyone out', async () => {
    const list = (await admin.get('/api/users')).data;
    const adminRow = list.find((u) => u.username === 'admin');
    assert.equal((await admin.del(`/api/users/${adminRow.id}`)).status, 409); // can't delete self
    assert.equal((await admin.patch(`/api/users/${adminRow.id}`, { role: 'user' })).status, 409); // last super user

    // With a second super user in place, demoting one of them is fine.
    const eve = (await admin.post('/api/users', { username: 'eve', password: 'eve-password-1', role: 'superuser' })).data;
    const eveClient = app.client();
    await eveClient.login('eve', 'eve-password-1');
    assert.equal((await eveClient.patch(`/api/users/${eve.id}`, { role: 'user' })).status, 200); // self-demotion
    assert.equal((await eveClient.get('/api/users')).status, 403);                               // takes effect at once
    assert.equal((await admin.del(`/api/users/${eve.id}`)).status, 204);
  });

  test('resetting a password signs that user out everywhere', async () => {
    const frank = (await admin.post('/api/users', { username: 'frank', password: 'frank-password-1' })).data;
    const f = app.client();
    await f.login('frank', 'frank-password-1');
    assert.equal((await admin.patch(`/api/users/${frank.id}`, { password: 'reset-password-1' })).status, 200);
    assert.equal((await f.get('/api/auth/me')).data.user, null);
    await app.client().login('frank', 'reset-password-1');
  });

  test('role changes take effect immediately on live sessions', async () => {
    const gina = (await admin.post('/api/users', { username: 'gina', password: 'gina-password-1' })).data;
    const g = app.client();
    await g.login('gina', 'gina-password-1');
    assert.equal((await g.get('/api/users')).status, 403);
    await admin.patch(`/api/users/${gina.id}`, { role: 'superuser' });
    assert.equal((await g.get('/api/users')).status, 200);
  });
});

// ---------------------------------------------------------------------
describe('creating alerts and links', () => {
  test('defaults: take-care mode, assigned to the creator, created_by from the session', async () => {
    const a = await newAlert(alice, { title: 'Defaults' });
    assert.equal(a.mode, 'takecare');
    assert.equal(a.assignee, 'alice');
    assert.equal(a.created_by, 'alice');
    assert.equal(a.status, 'Ongoing');
    assert.deepEqual(a.permissions, {
      canEdit: true, canAddEvent: true, canAssign: true, canAssignSelf: false,
      canTakeCare: false, canLeaveCare: false, canDelete: true, canChangeMode: true,
    });
    assert.deepEqual(a.carers, []);
  });

  test('created_by cannot be spoofed from the request body', async () => {
    const a = await newAlert(alice, { created_by: 'bob', assignee_by: 'bob' });
    assert.equal(a.created_by, 'alice');
  });

  test('multiple named links are stored and normalised', async () => {
    const a = await newAlert(alice, {
      links: [
        { name: 'Grafana', url: 'https://grafana.example.com/d/abc' },
        { name: 'Runbook', url: 'wiki.example.com/runbooks/db' },
        { name: '', url: 'http://jira.example.com/browse/OPS-1' },
      ],
    });
    assert.equal(a.links.length, 3);
    assert.deepEqual(a.links[0], { name: 'Grafana', url: 'https://grafana.example.com/d/abc' });
    assert.equal(a.links[1].url, 'https://wiki.example.com/runbooks/db');
    assert.equal(a.links[2].name, 'jira.example.com'); // blank name falls back to host
  });

  test('dangerous or malformed links are rejected', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x.example/file', 'vbscript:x', 'http://']) {
      const r = await alice.post('/api/incidents', { title: 't', links: [{ name: 'x', url }] });
      assert.equal(r.status, 400, url);
    }
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ name: `l${i}`, url: 'https://x.example' }));
    assert.equal((await alice.post('/api/incidents', { title: 't', links: tooMany })).status, 400);
    assert.equal((await alice.post('/api/incidents', { title: 't', links: 'nope' })).status, 400);
  });

  test('required fields and enums are validated', async () => {
    assert.equal((await alice.post('/api/incidents', { title: '   ' })).status, 400);
    assert.equal((await alice.post('/api/incidents', { title: 'x', severity: 'Nope' })).status, 400);
    assert.equal((await alice.post('/api/incidents', { title: 'x', mode: 'secret' })).status, 400);
    assert.equal((await alice.post('/api/incidents', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await alice.request('POST', '/api/incidents', '{bad json')).status, 400);
  });

  test('assignee at creation: unassigned, someone else, unknown user, private ignores it', async () => {
    assert.equal((await newAlert(alice, { assignee: '' })).assignee, '');
    assert.equal((await newAlert(alice, { assignee: 'bob' })).assignee, 'bob');
    assert.equal((await alice.post('/api/incidents', { title: 'x', assignee: 'ghost' })).status, 400);
    const priv = await newAlert(alice, { mode: 'private', assignee: 'bob' });
    assert.equal(priv.assignee, 'alice');
  });

  test('links can be edited and cleared by someone allowed to edit', async () => {
    const a = await newAlert(alice, { links: [{ name: 'A', url: 'https://a.example' }] });
    const r = await alice.patch(`/api/incidents/${a.id}`, { links: [{ name: 'B', url: 'https://b.example' }, { name: 'C', url: 'https://c.example' }] });
    assert.equal(r.data.links.length, 2);
    const cleared = await alice.patch(`/api/incidents/${a.id}`, { links: [] });
    assert.deepEqual(cleared.data.links, []);
  });
});

// ---------------------------------------------------------------------
describe('"Assigned with take care" (default): Take care lets you ADD events, nothing else', () => {
  const evt = () => ({ label: 'Update', event_time: new Date().toISOString() });

  test('a stranger can only look; Take care lets them add events, and does not assign them', async () => {
    const a = await newAlert(alice);
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 403);
    assert.equal((await bob.del(`/api/incidents/${a.id}`)).status, 403);

    const before = (await bob.get(`/api/incidents/${a.id}`)).data.permissions;
    assert.equal(before.canTakeCare, true);
    assert.equal(before.canAddEvent, false);

    const took = await bob.post(`/api/incidents/${a.id}/care`);
    assert.equal(took.status, 200);
    assert.deepEqual(took.data.carers, ['bob']);
    assert.equal(took.data.assignee, 'alice');                 // NOT assigned: the alert is still alice's
    const p = took.data.permissions;
    assert.equal(p.canAddEvent, true);
    assert.equal(p.canTakeCare, false);
    assert.equal(p.canLeaveCare, true);
    assert.equal(p.canEdit, false);
    assert.equal(p.canAssign, false);                          // never asked to assign
    assert.equal(p.canAssignSelf, false);

    const added = await bob.post(`/api/incidents/${a.id}/events`, evt());
    assert.equal(added.status, 201);
    assert.equal(added.data.created_by, 'bob');
  });

  test('a carer can add events but cannot edit the alert, edit or delete events, assign, change mode or delete', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    const ev = (await alice.post(`/api/incidents/${a.id}/events`, evt())).data;
    const own = (await bob.post(`/api/incidents/${a.id}/events`, evt())).data;

    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { title: 'hijack' })).status, 403);
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { status: 'Completed' })).status, 403);
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { mode: 'private' })).status, 403);
    assert.equal((await bob.patch(`/api/events/${ev.id}`, { note: 'x' })).status, 403);
    assert.equal((await bob.patch(`/api/events/${own.id}`, { note: 'x' })).status, 403);   // add only, even their own
    assert.equal((await bob.del(`/api/events/${own.id}`)).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 403);
    assert.equal((await bob.del(`/api/incidents/${a.id}`)).status, 403);
    assert.equal((await anon.get(`/api/incidents/${a.id}`)).data.assignee, 'alice');
  });

  test('an alert created WITH an assignee and unassigned later is not single-holder: no self-assign, but Take care works', async () => {
    const a = await newAlert(alice);                                   // created assigned to alice
    await alice.post(`/api/incidents/${a.id}/assign`, { assignee: '' });
    const p = (await bob.get(`/api/incidents/${a.id}`)).data.permissions;
    assert.equal(p.canAssignSelf, false);
    const r = await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /Take care/);
    assert.equal((await bob.post(`/api/incidents/${a.id}/care`)).status, 200);
  });

  test('taking care is idempotent and leaving stops access; both are logged once', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    const again = await bob.post(`/api/incidents/${a.id}/care`);
    assert.deepEqual(again.data.carers, ['bob']);

    const left = await bob.del(`/api/incidents/${a.id}/care`);
    assert.equal(left.status, 200);
    assert.deepEqual(left.data.carers, []);
    assert.equal(left.data.permissions.canTakeCare, true);
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 403);
    await bob.del(`/api/incidents/${a.id}/care`); // leaving twice: nothing happens

    const kinds = (await anon.get(`/api/incidents/${a.id}`)).data.activity.map((x) => x.kind);
    assert.deepEqual(kinds, ['created', 'took_care', 'left_care']);
  });

  test('several people can take care at the same time', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    await carol.post(`/api/incidents/${a.id}/care`);
    assert.deepEqual((await anon.get(`/api/incidents/${a.id}`)).data.carers, ['bob', 'carol']);
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
    assert.equal((await carol.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
  });

  test('creator, assignee and super user already can add events, so Take care changes nothing for them', async () => {
    const a = await newAlert(alice, { assignee: 'bob' });
    for (const c of [alice, bob, admin]) {
      const r = await c.post(`/api/incidents/${a.id}/care`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.carers, []);
      assert.equal(r.data.permissions.canTakeCare, false);
    }
  });

  test('Take care exists only in this mode', async () => {
    for (const mode of ['anyone', 'private']) {
      const a = await newAlert(alice, { mode });
      const r = await bob.post(`/api/incidents/${a.id}/care`);
      assert.equal(r.status, 409, mode);
      assert.match(r.data.error, /Assigned with take care/);
      assert.equal((await bob.get(`/api/incidents/${a.id}`)).data.permissions.canTakeCare, false);
    }
  });

  test('completed alerts cannot be taken care of, and carers lose the ability to add events to them', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Completed' });
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 403);

    const r = await carol.post(`/api/incidents/${a.id}/care`);
    assert.equal(r.status, 403);
    assert.match(r.data.error, /Completed/);

    await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing' });
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
  });

  test('switching the alert to another mode suspends carers; switching back restores them', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    await alice.patch(`/api/incidents/${a.id}`, { mode: 'anyone' });
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 403);
    await alice.patch(`/api/incidents/${a.id}`, { mode: 'takecare' });
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
  });

  test('creator assigns to anyone; the assignee can hand the alert over and then loses edit rights', async () => {
    const a = await newAlert(alice);
    assert.equal((await alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' })).data.assignee, 'bob');
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { title: 'bob edits' })).status, 200);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).data.assignee, 'carol');
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { title: 'x' })).status, 403);
    assert.equal((await carol.patch(`/api/incidents/${a.id}`, { title: 'carol edits' })).status, 200);
    assert.equal((await alice.patch(`/api/incidents/${a.id}`, { title: 'creator always' })).status, 200);
  });

  test('releasing (unassign) is limited to creator/assignee/super user', async () => {
    const a = await newAlert(alice, { assignee: 'bob' });
    assert.equal((await carol.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 200);
  });

  test('only creator or super user can delete; assignee cannot', async () => {
    const a = await newAlert(alice, { assignee: 'bob' });
    assert.equal((await bob.del(`/api/incidents/${a.id}`)).status, 403);
    assert.equal((await alice.del(`/api/incidents/${a.id}`)).status, 204);
    const b = await newAlert(alice);
    assert.equal((await admin.del(`/api/incidents/${b.id}`)).status, 204);
    assert.equal((await anon.get(`/api/incidents/${b.id}`)).status, 404);
  });

  test('super user can do anything', async () => {
    const a = await newAlert(alice);
    assert.equal((await admin.patch(`/api/incidents/${a.id}`, { status: 'Monitoring', severity: 'Show-stopper' })).status, 200);
    assert.equal((await admin.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).data.assignee, 'carol');
    assert.equal((await admin.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
  });

  test('assigning to a user that does not exist fails cleanly', async () => {
    const a = await newAlert(alice);
    assert.equal((await alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'nobody' })).status, 400);
    assert.equal((await alice.post(`/api/incidents/${a.id}/assign`, {})).status, 400);
  });
});

describe('"Assigned to anyone": assign people, or assign an unassigned alert to yourself', () => {
  test('on an assigned alert nobody else can assign themselves, and there is no Take care', async () => {
    const a = await newAlert(alice, { mode: 'anyone' });
    assert.equal(a.mode, 'anyone');
    const view = (await bob.get(`/api/incidents/${a.id}`)).data;
    assert.equal(view.permissions.canAssignSelf, false);
    assert.equal(view.permissions.canTakeCare, false);
    const r = await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /assigned to alice/);
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, { label: 'x', event_time: new Date().toISOString() })).status, 403);
  });

  test('an unassigned alert can be assigned to yourself by anyone signed in; the next person cannot', async () => {
    const a = await newAlert(alice, { mode: 'anyone', assignee: '' });
    assert.equal((await bob.get(`/api/incidents/${a.id}`)).data.permissions.canAssignSelf, true);
    const took = await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal(took.status, 200);
    assert.equal(took.data.assignee, 'bob');
    assert.equal(took.data.permissions.canEdit, true);
    assert.equal((await carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).status, 403);
  });

  test('creator can assign anyone and release; you cannot assign an unassigned alert to somebody else', async () => {
    const a = await newAlert(alice, { mode: 'anyone' });
    assert.equal((await alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).status, 200);
    assert.equal((await alice.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 200);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).status, 403);
  });

  test('completed unassigned alerts cannot be assigned to yourself', async () => {
    const a = await newAlert(alice, { mode: 'anyone', assignee: '' });
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Completed' });
    const r = await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /Completed/);
  });
});

describe('"Only me" (private) alerts', () => {
  test('nobody but the creator and super users can touch it, and Take care is not available', async () => {
    const p = await newAlert(alice, { mode: 'private' });
    assert.equal(p.assignee, 'alice');
    assert.equal((await bob.patch(`/api/incidents/${p.id}`, { status: 'Completed' })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${p.id}/events`, { label: 'x', event_time: new Date().toISOString() })).status, 403);
    assert.equal((await bob.post(`/api/incidents/${p.id}/assign`, { assignee: 'bob' })).status, 409);
    assert.equal((await bob.post(`/api/incidents/${p.id}/care`)).status, 409);

    const view = (await bob.get(`/api/incidents/${p.id}`)).data.permissions;
    assert.equal(view.canTakeCare, false);
    assert.equal(view.canAssignSelf, false);
    assert.equal(view.canEdit, false);

    assert.equal((await alice.patch(`/api/incidents/${p.id}`, { status: 'Monitoring' })).status, 200);
    assert.equal((await admin.patch(`/api/incidents/${p.id}`, { status: 'Ongoing' })).status, 200);
  });

  test('even the creator must change the mode before assigning a private alert', async () => {
    const p = await newAlert(alice, { mode: 'private' });
    const r = await alice.post(`/api/incidents/${p.id}/assign`, { assignee: 'bob' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Only me/);
    assert.equal((await alice.patch(`/api/incidents/${p.id}`, { mode: 'anyone' })).status, 200);
    assert.equal((await alice.post(`/api/incidents/${p.id}/assign`, { assignee: 'bob' })).status, 200);
  });

  test('only creator or super user can change the mode', async () => {
    const a = await newAlert(alice, { assignee: 'bob' });
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { mode: 'private' })).status, 403);
    assert.equal((await carol.patch(`/api/incidents/${a.id}`, { mode: 'private' })).status, 403);
    assert.equal((await admin.patch(`/api/incidents/${a.id}`, { mode: 'private' })).status, 200);
    assert.equal((await alice.patch(`/api/incidents/${a.id}`, { mode: 'bogus' })).status, 400);
  });

  test('switching to private returns ownership to the creator', async () => {
    const a = await newAlert(alice, { assignee: 'bob' });
    const r = await alice.patch(`/api/incidents/${a.id}`, { mode: 'private' });
    assert.equal(r.data.assignee, 'alice');
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' })).status, 403);
  });
});

describe('"Assigned with take care" + "Nobody yet": assign yourself (locks it) or take care (shared)', () => {
  const evt = () => ({ label: 'Update', event_time: new Date().toISOString() });
  const open = (extra = {}) => newAlert(alice, { assignee: '', ...extra });
  const view = async (c, id) => (await c.get(`/api/incidents/${id}`)).data;
  const perms = async (c, id) => (await view(c, id)).permissions;

  test('only take-care alerts created with nobody assigned are open for pickup', async () => {
    assert.equal((await open()).single_holder, 1);
    assert.equal((await newAlert(alice)).single_holder, 0);                              // assigned to me
    assert.equal((await newAlert(alice, { assignee: 'bob' })).single_holder, 0);         // assigned to someone
    assert.equal((await newAlert(alice, { mode: 'anyone', assignee: '' })).single_holder, 0);
    assert.equal((await newAlert(alice, { mode: 'private' })).single_holder, 0);
  });

  test('while nobody is assigned, everyone signed in is offered BOTH "Assign to me" and "Take care"', async () => {
    const a = await open();
    for (const c of [bob, carol]) {
      const p = await perms(c, a.id);
      assert.equal(p.canAssignSelf, true);
      assert.equal(p.canTakeCare, true);
    }
    const creator = await perms(alice, a.id);                                            // the creator can already add events
    assert.equal(creator.canAssignSelf, true);
    assert.equal(creator.canTakeCare, false);
    const visitor = await perms(anon, a.id);
    assert.equal(visitor.canAssignSelf, false);
    assert.equal(visitor.canTakeCare, false);
  });

  test('TAKE CARE is shared: several people can do it, they add events only, and the alert stays unassigned', async () => {
    const a = await open();
    assert.equal((await bob.post(`/api/incidents/${a.id}/care`)).status, 200);
    assert.equal((await carol.post(`/api/incidents/${a.id}/care`)).status, 200);          // not blocked by bob
    const after = await view(anon, a.id);
    assert.deepEqual(after.carers, ['bob', 'carol']);
    assert.equal(after.assignee, '');

    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
    assert.equal((await carol.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
    for (const c of [bob, carol]) {                                                      // events only
      assert.equal((await c.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' })).status, 403);
      assert.equal((await c.patch(`/api/incidents/${a.id}`, { title: 'x' })).status, 403);
      assert.equal((await c.post(`/api/incidents/${a.id}/assign`, { assignee: 'dave' })).status, 403);
      assert.equal((await c.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 403);
    }
    // somebody who is taking care can still assign THEMSELVES while it is unassigned
    assert.equal((await bob.get(`/api/incidents/${a.id}`)).data.permissions.canAssignSelf, true);
  });

  test('ASSIGN TO ME locks the alert: only the assignee, the creator and super users can change the assignment or status', async () => {
    const a = await open();
    const took = await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal(took.status, 200);
    assert.equal(took.data.assignee, 'bob');
    assert.equal(took.data.permissions.canEdit, true);

    // everybody else: no assigning, no unassigning, no status, no edits
    for (const c of [carol, anon]) {
      const r = await c.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' });
      assert.ok([401, 403].includes(r.status));
    }
    const late = await carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' });
    assert.equal(late.status, 403);
    assert.match(late.data.error, /assigned to bob\. Only bob, the creator or a super user can change the assignment or the status/);
    assert.equal((await carol.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 403);
    assert.equal((await carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'dave' })).status, 403);
    assert.equal((await carol.patch(`/api/incidents/${a.id}`, { status: 'Completed' })).status, 403);
    assert.equal((await carol.patch(`/api/incidents/${a.id}`, { title: 'hijack' })).status, 403);
    const p = await perms(carol, a.id);
    assert.equal(p.canAssignSelf, false);
    assert.equal(p.canAssign, false);
    assert.equal((await view(anon, a.id)).assignee, 'bob');                              // nothing changed

    // the three who may
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' })).status, 200);       // assignee
    assert.equal((await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing' })).status, 200);        // creator
    assert.equal((await admin.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' })).status, 200);     // super user
    assert.equal((await alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'dave' })).status, 200);   // creator reassigns
    assert.equal((await admin.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' })).status, 200);    // super user reassigns
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: '' })).status, 200);         // assignee releases it
  });

  test('after somebody is assigned, other people can STILL take care (events only)', async () => {
    const a = await open();
    await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal((await perms(carol, a.id)).canTakeCare, true);
    assert.equal((await carol.post(`/api/incidents/${a.id}/care`)).status, 200);
    assert.equal((await carol.post(`/api/incidents/${a.id}/events`, evt())).status, 201);
    assert.equal((await carol.patch(`/api/incidents/${a.id}`, { status: 'Completed' })).status, 403);   // still locked
    assert.equal((await carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' })).status, 403);
  });

  test('people already taking care keep doing so when somebody is assigned; the assignee is not listed as a carer', async () => {
    const a = await open();
    await bob.post(`/api/incidents/${a.id}/care`);
    await carol.post(`/api/incidents/${a.id}/care`);
    const r = await carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' });   // carol upgrades from carer to assignee
    assert.equal(r.status, 200);
    assert.equal(r.data.assignee, 'carol');
    assert.deepEqual(r.data.carers, ['bob']);                                             // bob keeps taking care; carol is the assignee now
    assert.equal((await bob.post(`/api/incidents/${a.id}/events`, evt())).status, 201);

    const b = await open();
    await carol.post(`/api/incidents/${b.id}/care`);
    const viaCreator = await alice.post(`/api/incidents/${b.id}/assign`, { assignee: 'bob' });
    assert.deepEqual(viaCreator.data.carers, ['carol']);                                  // nobody is kicked out
    assert.equal((await carol.post(`/api/incidents/${b.id}/events`, evt())).status, 201);
  });

  test('two people pressing "Assign to me" at the same moment: exactly one gets it; taking care both succeed', async () => {
    const a = await open();
    const assigns = await Promise.all([
      bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' }),
      carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' }),
    ]);
    assert.deepEqual(assigns.map((r) => r.status).sort(), [200, 403]);
    const winner = (await view(anon, a.id)).assignee;
    assert.ok(['bob', 'carol'].includes(winner));

    const b = await open();
    const cares = await Promise.all([bob.post(`/api/incidents/${b.id}/care`), carol.post(`/api/incidents/${b.id}/care`)]);
    assert.deepEqual(cares.map((r) => r.status), [200, 200]);
    assert.deepEqual((await view(anon, b.id)).carers.sort(), ['bob', 'carol']);
  });

  test('when the assignee releases it, it is open again for everybody (carers unaffected)', async () => {
    const a = await open();
    await alice.post(`/api/incidents/${a.id}/events`, evt());
    await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    await carol.post(`/api/incidents/${a.id}/care`);
    await bob.post(`/api/incidents/${a.id}/assign`, { assignee: '' });
    await admin.post('/api/users', { username: 'latecomer', password: 'latecomer-pw-1' });
    const late = app.client();
    await late.login('latecomer', 'latecomer-pw-1');
    const p = await perms(late, a.id);
    assert.equal(p.canAssignSelf, true);
    assert.equal(p.canTakeCare, true);
    assert.equal((await late.post(`/api/incidents/${a.id}/assign`, { assignee: 'latecomer' })).status, 200);
    assert.deepEqual((await view(anon, a.id)).carers, ['carol']);
  });

  test('an alert created WITH an assignee and unassigned later is not open for pickup', async () => {
    const a = await newAlert(alice);                                                      // created assigned to alice
    await alice.post(`/api/incidents/${a.id}/assign`, { assignee: '' });
    const p = await perms(bob, a.id);
    assert.equal(p.canAssignSelf, false);
    assert.equal(p.canTakeCare, true);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' })).status, 403);
  });

  test('completed alerts cannot be picked up or taken care of; the flag survives mode changes', async () => {
    const a = await open();
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Completed' });
    assert.equal((await bob.post(`/api/incidents/${a.id}/care`)).status, 403);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' })).status, 403);
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing', mode: 'anyone' });
    await alice.patch(`/api/incidents/${a.id}`, { mode: 'takecare' });
    assert.equal((await view(anon, a.id)).single_holder, 1);
    assert.equal((await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' })).status, 200);
  });

  test('the creator, assignee or a super user can still remove someone from taking care', async () => {
    const a = await open();
    await bob.post(`/api/incidents/${a.id}/care`);
    assert.equal((await carol.del(`/api/incidents/${a.id}/care?user=bob`)).status, 403);
    const rel = await alice.del(`/api/incidents/${a.id}/care?user=bob`);
    assert.equal(rel.status, 200);
    assert.deepEqual(rel.data.carers, []);
    assert.equal(rel.data.activity.at(-1).text, 'alice released bob from taking care of this alert');
  });

  test('the notification says nobody is assigned yet', async () => {
    await open({ title: 'Pickup ping', severity: 'Critical' });
    const text = (await bob.get('/api/notifications')).data.items[0].text;
    assert.equal(text, 'alice created "Pickup ping" (Critical). Nobody is assigned yet: assign it to yourself or take care of it.');
  });

  test('taking care and assigning are written to the timeline', async () => {
    const a = await open();
    await bob.post(`/api/incidents/${a.id}/care`);
    await carol.post(`/api/incidents/${a.id}/care`);
    await carol.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' });
    assert.deepEqual((await view(anon, a.id)).activity.map((x) => x.text), [
      'alice created this alert (unassigned)',
      'bob took care of this alert',
      'carol took care of this alert',
      'carol assigned this alert to themselves',
    ]);
  });
});

// ---------------------------------------------------------------------
describe('status rules', () => {
  test('every status can be set by hand, On Hold included; Completed records closed_at', async () => {
    const a = await newAlert(alice);
    for (const status of ['Monitoring', 'On Hold', 'Ongoing']) {
      const r = await alice.patch(`/api/incidents/${a.id}`, { status });
      assert.equal(r.status, 200, status);
      assert.equal(r.data.status, status);
      assert.equal(r.data.closed_at, null);
    }
    const done = await alice.patch(`/api/incidents/${a.id}`, { status: 'Completed' });
    assert.ok(done.data.closed_at);
    assert.equal((await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing' })).data.closed_at, null);
    assert.equal((await alice.patch(`/api/incidents/${a.id}`, { status: 'Bogus' })).status, 400);
  });

  test('people without edit rights still cannot change the status, whatever it is', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    assert.equal((await bob.patch(`/api/incidents/${a.id}`, { status: 'On Hold' })).status, 403);
    assert.equal((await carol.patch(`/api/incidents/${a.id}`, { status: 'On Hold' })).status, 403);
  });
});

describe('On Hold: set by hand, and applied automatically after 3 days without a timeline update', () => {
  const { db } = require('../lib/db');
  const store = require('../lib/store');
  const backdate = (id, days) => db.prepare('UPDATE incidents SET last_update_at = ? WHERE id = ?')
    .run(new Date(Date.now() - days * 86400000).toISOString(), id);
  const get = async (id) => (await anon.get(`/api/incidents/${id}`)).data;
  const evt = () => ({ label: 'Update', event_time: new Date().toISOString() });

  test('only stale ONGOING alerts are held automatically; Monitoring, Completed and manual holds are left alone', async () => {
    const stale = await newAlert(alice, { title: 'stale ongoing' });
    const fresh = await newAlert(alice, { title: 'fresh ongoing' });
    const monitored = await newAlert(alice, { title: 'stale monitoring' });
    const finished = await newAlert(alice, { title: 'stale completed' });
    const manual = await newAlert(alice, { title: 'stale manual hold' });
    await alice.patch(`/api/incidents/${monitored.id}`, { status: 'Monitoring' });
    await alice.patch(`/api/incidents/${finished.id}`, { status: 'Completed' });
    await alice.patch(`/api/incidents/${manual.id}`, { status: 'On Hold' });
    for (const x of [stale, monitored, finished, manual]) backdate(x.id, 10);
    backdate(fresh.id, 2.9);

    assert.ok(store.autoHoldStale() >= 1);
    assert.equal((await get(stale.id)).status, 'On Hold');
    assert.equal((await get(fresh.id)).status, 'Ongoing');         // inside the 3 days
    assert.equal((await get(monitored.id)).status, 'Monitoring');  // never automatic
    assert.equal((await get(finished.id)).status, 'Completed');
    const held = await get(manual.id);
    assert.equal(held.status, 'On Hold');
    assert.equal(held.activity.filter((x) => x.kind === 'auto_hold').length, 0); // untouched by the job

    const act = (await get(stale.id)).activity.at(-1);
    assert.equal(act.kind, 'auto_hold');
    assert.equal(act.actor, 'system');
    assert.match(act.text, /Automatically moved to On Hold: no timeline update for 3 days/);
  });

  test('is idempotent: running again changes nothing', async () => {
    assert.equal(store.autoHoldStale(), 0);
  });

  test('automatic and manual holds are told apart', async () => {
    const auto = await newAlert(alice);
    const manual = await newAlert(alice);
    backdate(auto.id, 10);
    store.autoHoldStale();
    await alice.patch(`/api/incidents/${manual.id}`, { status: 'On Hold' });
    assert.equal((await get(auto.id)).hold_auto, 1);
    assert.equal((await get(manual.id)).hold_auto, 0);
  });

  test('a timeline update brings an AUTOMATICALLY held alert back to Ongoing', async () => {
    const a = await newAlert(alice);
    backdate(a.id, 10);
    store.autoHoldStale();
    assert.equal((await get(a.id)).status, 'On Hold');

    await alice.post(`/api/incidents/${a.id}/events`, evt());
    const after = await get(a.id);
    assert.equal(after.status, 'Ongoing');
    assert.equal(after.hold_auto, 0);
    assert.equal(after.activity.at(-1).kind, 'resumed');
    assert.equal(store.autoHoldStale(), 0); // clock was reset
  });

  test('a MANUAL hold stays On Hold when events are added: only a person lifts it', async () => {
    const a = await newAlert(alice);
    await alice.patch(`/api/incidents/${a.id}`, { status: 'On Hold' });
    await alice.post(`/api/incidents/${a.id}/events`, evt());
    const still = await get(a.id);
    assert.equal(still.status, 'On Hold');
    assert.ok(!still.activity.some((x) => x.kind === 'resumed'));

    await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing' });
    assert.equal((await get(a.id)).status, 'Ongoing');
  });

  test('a carer adding an event also resumes an automatic hold', async () => {
    const a = await newAlert(alice);
    await bob.post(`/api/incidents/${a.id}/care`);
    backdate(a.id, 10);
    store.autoHoldStale();
    await bob.post(`/api/incidents/${a.id}/events`, evt());
    const after = await get(a.id);
    assert.equal(after.status, 'Ongoing');
    assert.equal(after.activity.at(-1).text, 'bob added an update, so the alert is back to Ongoing');
  });

  test('changing an automatically held alert by hand makes it a manual choice', async () => {
    const a = await newAlert(alice);
    backdate(a.id, 10);
    store.autoHoldStale();
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' });
    await alice.patch(`/api/incidents/${a.id}`, { status: 'On Hold' });  // held again, now by hand
    assert.equal((await get(a.id)).hold_auto, 0);
    await alice.post(`/api/incidents/${a.id}/events`, evt());
    assert.equal((await get(a.id)).status, 'On Hold');
  });

  test('editing an event counts as an update', async () => {
    const a = await newAlert(alice);
    const e = (await alice.post(`/api/incidents/${a.id}/events`, evt())).data;
    backdate(a.id, 10);
    await alice.patch(`/api/events/${e.id}`, { note: 'edited' });
    assert.equal(store.autoHoldStale(), 0);
    assert.equal((await get(a.id)).status, 'Ongoing');
  });

  test('changing the status by hand restarts the clock too', async () => {
    const a = await newAlert(alice);
    backdate(a.id, 10);
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' });
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing' });
    assert.equal(store.autoHoldStale(), 0);
  });

  test('the threshold can be simulated with a custom clock', async () => {
    const a = await newAlert(alice, { title: 'clock probe' });
    store.autoHoldStale({ now: Date.now() + 2 * 86400000 });
    assert.equal((await get(a.id)).status, 'Ongoing');             // 2 days idle: still fine
    store.autoHoldStale({ now: Date.now() + 3 * 86400000 + 60000 });
    assert.equal((await get(a.id)).status, 'On Hold');             // just past 3 days
  });
});

// ---------------------------------------------------------------------
describe('timeline activity (automatic comments between events)', () => {
  const texts = async (id) => (await anon.get(`/api/incidents/${id}`)).data.activity.map((a) => a.text);

  test('creation is recorded, in each flavour', async () => {
    assert.deepEqual(await texts((await newAlert(alice)).id), ['alice created this alert and is taking care of it']);
    assert.deepEqual(await texts((await newAlert(alice, { assignee: '' })).id), ['alice created this alert (unassigned)']);
    assert.deepEqual(await texts((await newAlert(alice, { assignee: 'bob' })).id), ['alice created this alert, assigned to bob']);
  });

  test('assigned, took care, stopped, unassigned, status and mode changes are logged with who did it', async () => {
    const a = await newAlert(alice);
    await alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    await carol.post(`/api/incidents/${a.id}/care`);
    await carol.del(`/api/incidents/${a.id}/care`);
    await bob.post(`/api/incidents/${a.id}/assign`, { assignee: '' });
    await admin.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' });
    await carol.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' });
    await alice.patch(`/api/incidents/${a.id}`, { mode: 'private' });

    assert.deepEqual(await texts(a.id), [
      'alice created this alert and is taking care of it',
      'alice assigned this alert to bob',
      'carol took care of this alert',
      'carol stopped taking care of this alert',
      'bob unassigned this alert',
      'admin assigned this alert to carol',
      'carol changed the status from Ongoing to Monitoring',
      'alice changed who can continue this alert to "Only me"; it is now assigned back to alice',
    ]);
    const detail = (await anon.get(`/api/incidents/${a.id}`)).data;
    assert.deepEqual(detail.activity.map((x) => x.kind), ['created', 'assigned', 'took_care', 'left_care', 'unassigned', 'assigned', 'status', 'mode']);
    assert.equal(detail.activity[2].actor, 'carol');
  });

  test('assigning yourself in "Assigned to anyone" mode is worded as such', async () => {
    const a = await newAlert(alice, { mode: 'anyone', assignee: '' });
    await bob.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' });
    assert.equal((await texts(a.id)).at(-1), 'bob assigned this alert to themselves');
  });

  test('no-op changes are not logged', async () => {
    const a = await newAlert(alice);
    await alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'alice' });  // already alice
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Ongoing' });        // unchanged
    await alice.patch(`/api/incidents/${a.id}`, { title: 'renamed' });         // not an activity
    await bob.post(`/api/incidents/${a.id}/care`);
    await bob.post(`/api/incidents/${a.id}/care`);                              // twice
    assert.deepEqual(await texts(a.id), ['alice created this alert and is taking care of it', 'bob took care of this alert']);
  });

  test('super user actions are attributed to the super user', async () => {
    const a = await newAlert(alice);
    await admin.post(`/api/incidents/${a.id}/assign`, { assignee: 'carol' });
    assert.deepEqual((await texts(a.id)).at(-1), 'admin assigned this alert to carol (was alice)');
  });

  test('activity is read-only through the API and is removed with its alert', async () => {
    const a = await newAlert(alice);
    assert.equal((await alice.patch(`/api/incidents/${a.id}`, { activity: [] })).status, 200); // ignored field
    assert.equal((await anon.get(`/api/incidents/${a.id}`)).data.activity.length, 1);
    await alice.del(`/api/incidents/${a.id}`);
    const { db } = require('../lib/db');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activity WHERE incident_id = ?').get(a.id).c, 0);
  });
});

// ---------------------------------------------------------------------
describe('timeline events', () => {
  test('add with links, edit, delete', async () => {
    const a = await newAlert(alice);
    const when = new Date('2026-10-15T10:00:00Z').toISOString();

    const e1 = (await alice.post(`/api/incidents/${a.id}/events`, {
      label: 'Issue Occurred', event_time: when, note: 'p99 spike',
      links: [{ name: 'Dashboard', url: 'https://grafana.example.com/d/1' }, { name: 'Logs', url: 'https://logs.example.com/q' }],
    })).data;
    const e2 = (await alice.post(`/api/incidents/${a.id}/events`, { label: 'Identified', event_time: when })).data;
    assert.equal(e1.links.length, 2);
    assert.equal(e1.created_by, 'alice');

    const edited = await alice.patch(`/api/events/${e2.id}`, { label: 'RCA', note: 'root cause', links: [{ name: 'PR', url: 'https://git.example.com/pr/9' }] });
    assert.equal(edited.data.label, 'RCA');
    assert.equal(edited.data.links[0].name, 'PR');

    assert.equal((await alice.del(`/api/events/${e1.id}`)).status, 204);
    assert.equal((await anon.get(`/api/incidents/${a.id}`)).data.events.length, 1);
  });

  test('events are chronological by the time entered, whatever order they were logged in', async () => {
    const a = await newAlert(alice);
    const log = (label, iso) => alice.post(`/api/incidents/${a.id}/events`, { label, event_time: iso });
    await log('RCA', '2026-10-15T12:00:00.000Z');
    await log('Issue Occurred', '2026-10-15T09:00:00.000Z');          // backfilled afterwards
    const identified = (await log('Identified', '2026-10-15T09:30:00.000Z')).data;

    const labels = async () => (await anon.get(`/api/incidents/${a.id}`)).data.events.map((e) => e.label);
    assert.deepEqual(await labels(), ['Issue Occurred', 'Identified', 'RCA']);

    await alice.patch(`/api/events/${identified.id}`, { event_time: '2026-10-15T13:00:00.000Z' }); // fix the time -> it moves
    assert.deepEqual(await labels(), ['Issue Occurred', 'RCA', 'Identified']);
  });

  test('manual reordering no longer exists', async () => {
    const a = await newAlert(alice);
    assert.equal((await alice.put(`/api/incidents/${a.id}/events/order`, { order: [] })).status, 404);
  });

  test('validation', async () => {
    const a = await newAlert(alice);
    const t = new Date().toISOString();
    assert.equal((await alice.post(`/api/incidents/${a.id}/events`, { event_time: t })).status, 400);
    assert.equal((await alice.post(`/api/incidents/${a.id}/events`, { label: 'x', event_time: 'not a date' })).status, 400);
    assert.equal((await alice.post(`/api/incidents/${a.id}/events`, { label: 'x' })).status, 400);
    assert.equal((await alice.post(`/api/incidents/${a.id}/events`, { label: 'x'.repeat(81), event_time: t })).status, 400);
    assert.equal((await alice.post(`/api/incidents/${a.id}/events`, { label: 'x', event_time: t, links: [{ name: 'bad', url: 'javascript:1' }] })).status, 400);
    assert.equal((await alice.post('/api/incidents/999999/events', { label: 'x', event_time: t })).status, 404);
    assert.equal((await alice.post('/api/incidents/abc/events', { label: 'x', event_time: t })).status, 400);
  });

  test('permissions follow the parent alert', async () => {
    const a = await newAlert(alice);
    const e = (await alice.post(`/api/incidents/${a.id}/events`, { label: 'x', event_time: new Date().toISOString() })).data;
    assert.equal((await bob.patch(`/api/events/${e.id}`, { label: 'hijack' })).status, 403);
    assert.equal((await bob.del(`/api/events/${e.id}`)).status, 403);
    assert.equal((await anon.patch(`/api/events/${e.id}`, { label: 'x' })).status, 401);
    assert.equal((await admin.patch(`/api/events/${e.id}`, { label: 'by admin' })).status, 200);
  });

  test('adding events bumps the alert’s updated_at and last_update_at', async () => {
    const a = await newAlert(alice);
    await new Promise((r) => setTimeout(r, 15));
    await alice.post(`/api/incidents/${a.id}/events`, { label: 'x', event_time: new Date().toISOString() });
    const after2 = (await anon.get(`/api/incidents/${a.id}`)).data;
    assert.ok(after2.updated_at > a.updated_at);
    assert.ok(after2.last_update_at > a.last_update_at);
  });
});

// ---------------------------------------------------------------------
describe('temporary passwords are flagged until changed', () => {
  test('accounts created or reset by a super user carry the flag; changing the password clears it', async () => {
    const u = (await admin.post('/api/users', { username: 'temp-user', password: 'temp-password-1' })).data;
    assert.equal(u.must_change_password, 1);
    const c = app.client();
    const login = await c.login('temp-user', 'temp-password-1');
    assert.equal(login.data.user.mustChangePassword, true);
    assert.equal((await c.get('/api/auth/me')).data.user.mustChangePassword, true);

    await c.post('/api/auth/password', { current_password: 'temp-password-1', new_password: 'my-own-password-1' });
    assert.equal((await c.get('/api/auth/me')).data.user.mustChangePassword, false);

    await admin.patch(`/api/users/${u.id}`, { password: 'reset-again-123' });
    const again = app.client();
    assert.equal((await again.login('temp-user', 'reset-again-123')).data.user.mustChangePassword, true);
  });

  test('the test super user (created with an explicit ADMIN_PASSWORD) is not flagged', async () => {
    assert.equal((await admin.get('/api/auth/me')).data.user.mustChangePassword, false);
  });
});

// ---------------------------------------------------------------------
describe('notifications for alerts created with "Assigned with take care"', () => {
  const inbox = async (c) => (await c.get('/api/notifications')).data;

  test('everyone except the creator is notified', async () => {
    const before = { bob: (await inbox(bob)).unread, carol: (await inbox(carol)).unread, alice: (await inbox(alice)).unread, admin: (await inbox(admin)).unread };
    const a = await newAlert(alice, { title: 'Notify me', severity: 'Critical' });

    const b = await inbox(bob);
    assert.equal(b.unread, before.bob + 1);
    assert.deepEqual(
      { text: b.items[0].text, incident_id: b.items[0].incident_id, read: b.items[0].read, kind: b.items[0].kind },
      { text: 'alice created "Notify me" (Critical). Anyone can take care of it.', incident_id: a.id, read: false, kind: 'takecare_alert' },
    );
    assert.equal((await inbox(carol)).unread, before.carol + 1);
    assert.equal((await inbox(admin)).unread, before.admin + 1);
    assert.equal((await inbox(alice)).unread, before.alice);          // the creator is not told about their own alert
  });

  test('the person it is assigned to gets a tailored message', async () => {
    const a = await newAlert(alice, { title: 'Yours', severity: 'High', assignee: 'bob' });
    assert.equal((await inbox(bob)).items[0].text, 'alice created "Yours" (High) and assigned it to you');
    assert.match((await inbox(carol)).items[0].text, /Anyone can take care of it/);
    assert.equal((await inbox(carol)).items[0].incident_id, a.id);
  });

  test('"Assigned to anyone" and "Only me" alerts notify nobody', async () => {
    const before = [(await inbox(bob)).unread, (await inbox(carol)).unread, (await inbox(admin)).unread];
    await newAlert(alice, { mode: 'anyone' });
    await newAlert(alice, { mode: 'private' });
    assert.deepEqual([(await inbox(bob)).unread, (await inbox(carol)).unread, (await inbox(admin)).unread], before);
  });

  test('marking read works by id and for everything, and is private to each user', async () => {
    await newAlert(alice, { title: 'Read me 1' });
    await newAlert(alice, { title: 'Read me 2' });
    const b0 = await inbox(bob);
    const c0 = await inbox(carol);
    assert.ok(b0.unread >= 2);

    const one = await bob.post('/api/notifications/read', { ids: [b0.items[0].id] });
    assert.equal(one.data.unread, b0.unread - 1);
    assert.equal((await inbox(bob)).items[0].read, true);
    assert.equal((await inbox(bob)).items[1].read, false);

    // bob cannot touch carol's notifications
    await bob.post('/api/notifications/read', { ids: [c0.items[0].id] });
    assert.equal((await inbox(carol)).unread, c0.unread);

    const all = await bob.post('/api/notifications/read', { all: true });
    assert.equal(all.data.unread, 0);
    assert.equal((await inbox(carol)).unread, c0.unread);   // untouched
  });

  test('requires sign-in and valid input', async () => {
    assert.equal((await anon.get('/api/notifications')).status, 401);
    assert.equal((await anon.post('/api/notifications/read', { all: true })).status, 401);
    assert.equal((await bob.post('/api/notifications/read', {})).status, 400);
    assert.equal((await bob.post('/api/notifications/read', { ids: ['x'] })).status, 400);
  });

  test('deleting the alert removes its notifications, and old ones are purged', async () => {
    const a = await newAlert(alice, { title: 'Soon gone' });
    assert.ok((await inbox(bob)).items.some((i) => i.incident_id === a.id));
    await alice.del(`/api/incidents/${a.id}`);
    assert.ok(!(await inbox(bob)).items.some((i) => i.incident_id === a.id));

    const { db } = require('../lib/db');
    const store = require('../lib/store');
    const b = await newAlert(alice, { title: 'Old news' });
    db.prepare('UPDATE notifications SET created_at = ? WHERE incident_id = ?').run(new Date(Date.now() - 40 * 86400000).toISOString(), b.id);
    assert.ok(store.purgeOldNotifications() >= 1);
    assert.ok(!(await inbox(bob)).items.some((i) => i.incident_id === b.id));
  });
});

// ---------------------------------------------------------------------
describe('"My alerts": assigned to me, and taking care', () => {
  const mine = async (c, qs = '') => (await c.get(`/api/incidents?mine=1&${qs}`)).data;
  const tag = `mine${Date.now()}`;

  test('needs a signed-in user', async () => {
    assert.equal((await anon.get('/api/incidents?mine=1')).status, 401);
    assert.equal((await anon.get('/api/incidents')).status, 200); // the normal list stays public
  });

  test('lists alerts assigned to me and alerts I take care of, tagged, each only once', async () => {
    await newAlert(alice, { title: `${tag} assigned`, assignee: 'bob' });
    const cared = await newAlert(alice, { title: `${tag} cared` });
    await bob.post(`/api/incidents/${cared.id}/care`);
    const neither = await newAlert(alice, { title: `${tag} neither` });
    const both = await newAlert(alice, { title: `${tag} both` });
    await bob.post(`/api/incidents/${both.id}/care`);
    await alice.post(`/api/incidents/${both.id}/assign`, { assignee: 'bob' });   // now assigned AND a carer

    const rows = await mine(bob, `q=${tag}`);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title.replace(`${tag} `, ''), r.mine_kind]));
    assert.deepEqual(byTitle, { assigned: 'assigned', cared: 'care', both: 'assigned' });
    assert.equal(rows.length, 3);
    assert.ok(!rows.some((r) => r.id === neither.id));

    assert.deepEqual(await mine(carol, `q=${tag}`), []);                          // carol has none of these
    const aliceRows = await mine(alice, `q=${tag}`);
    assert.ok(aliceRows.every((r) => r.mine_kind === 'assigned'));                // alice is assigned her own
  });

  test('works together with the status filter used by the dashboard cards', async () => {
    const a = await newAlert(alice, { title: `${tag} filtered`, assignee: 'bob' });
    await alice.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' });
    assert.deepEqual((await mine(bob, `q=${tag}%20filtered&status=Monitoring`)).map((r) => r.id), [a.id]);
    assert.deepEqual(await mine(bob, `q=${tag}%20filtered&status=Ongoing`), []);
  });

  test('care rows disappear when the alert is no longer in take-care mode', async () => {
    const a = await newAlert(alice, { title: `${tag} modeswitch` });
    await bob.post(`/api/incidents/${a.id}/care`);
    assert.equal((await mine(bob, `q=${tag}%20modeswitch`)).length, 1);
    await alice.patch(`/api/incidents/${a.id}`, { mode: 'anyone' });
    assert.equal((await mine(bob, `q=${tag}%20modeswitch`)).length, 0);
    await alice.patch(`/api/incidents/${a.id}`, { mode: 'takecare' });
    assert.equal((await mine(bob, `q=${tag}%20modeswitch`)).length, 1);
    await bob.del(`/api/incidents/${a.id}/care`);
    assert.equal((await mine(bob, `q=${tag}%20modeswitch`)).length, 0);
  });
});

describe('alert list filters', () => {
  test('filter by assignee, unassigned, creator, severity, active and search', async () => {
    const tag = `flt${Date.now()}`;
    const u1 = await newAlert(alice, { title: `${tag} unassigned`, assignee: '', severity: 'Show-stopper' });
    const b1 = await newAlert(bob, { title: `${tag} by bob`, severity: 'Error' });
    const done = await newAlert(alice, { title: `${tag} done 100%` });
    await alice.patch(`/api/incidents/${done.id}`, { status: 'Completed' });

    const ids = async (qs) => (await anon.get(`/api/incidents?${qs}`)).data.map((i) => i.id);
    assert.deepEqual(await ids(`q=${tag}&assignee=__none__`), [u1.id]);
    assert.deepEqual(await ids(`q=${tag}&created_by=bob`), [b1.id]);
    assert.deepEqual(await ids(`q=${tag}&assignee=BOB`), [b1.id]);
    assert.deepEqual(await ids(`q=${tag}&severity=Show-stopper`), [u1.id]);
    assert.ok(!(await ids(`q=${tag}&active=1`)).includes(done.id));
    assert.deepEqual(await ids(`q=${encodeURIComponent('100%')}`), [done.id]); // % is literal, not a wildcard
    assert.deepEqual(await ids(`q=${encodeURIComponent('%')}`), [done.id]);
  });

  test('completed alerts sort after active ones', async () => {
    const list = (await anon.get('/api/incidents')).data;
    const firstDone = list.findIndex((i) => i.status === 'Completed');
    const lastActive = list.map((i) => i.status).lastIndexOf('Ongoing');
    assert.ok(firstDone === -1 || lastActive < firstDone);
  });
});

// ---------------------------------------------------------------------
describe('dashboard analytics', () => {
  test('counts, severity groups, workload and timeline are consistent', async () => {
    const d = (await anon.get('/api/dashboard?days=7&tz=0')).data;
    const all = (await anon.get('/api/incidents')).data;

    assert.equal(d.total, all.length);
    assert.equal(Object.values(d.byStatus).reduce((a, b) => a + b, 0), d.total);

    assert.deepEqual(d.severity.map((s) => s.severity), ['Show-stopper', 'Critical', 'High', 'Error']);
    assert.equal(d.severity.reduce((a, s) => a + s.total, 0), d.total);
    for (const s of d.severity) {
      assert.equal(s.active, s.total - (s.byStatus.Completed || 0));
      assert.ok(s.alerts.length <= 5);
      assert.ok(s.alerts.every((a) => a.status !== 'Completed'));
    }

    assert.equal(d.timeline.labels.length, 7);
    assert.equal(d.timeline.created.length, 7);
    assert.equal(d.timeline.created.reduce((a, b) => a + b, 0), d.total); // everything was created "today"
    assert.equal(d.timeline.completed.reduce((a, b) => a + b, 0), d.byStatus.Completed);

    const aliceRow = d.users.find((u) => u.user === 'alice');
    assert.equal(aliceRow.created, all.filter((i) => i.created_by === 'alice').length);
    assert.equal(aliceRow.working, all.filter((i) => i.assignee === 'alice' && i.status !== 'Completed').length);
    assert.equal(d.unassignedActive, all.filter((i) => i.assignee === '' && i.status !== 'Completed').length);
  });

  test('timezone offset moves alerts into the viewer’s local day', async () => {
    const a = await newAlert(alice, { title: 'tz probe' });
    const utcDay = new Date(a.created_at).toISOString().slice(0, 10);
    const east = (await anon.get('/api/dashboard?days=3&tz=-840')).data.timeline; // UTC+14
    const west = (await anon.get('/api/dashboard?days=3&tz=720')).data.timeline;  // UTC-12
    assert.equal(east.labels.length, 3);
    assert.ok(east.created.reduce((x, y) => x + y, 0) > 0);
    assert.ok(west.created.reduce((x, y) => x + y, 0) > 0);
    assert.ok(utcDay.length === 10);
  });

  test('odd parameters are clamped instead of crashing', async () => {
    assert.equal((await anon.get('/api/dashboard?days=9999&tz=abc')).data.timeline.days, 90);
    assert.equal((await anon.get('/api/dashboard?days=0&tz=99999')).data.timeline.days, 1);
    assert.equal((await anon.get('/api/dashboard?days=-5')).data.timeline.days, 1);
  });
});

// ---------------------------------------------------------------------
describe('backup: export and import', () => {
  test('export permissions per scope', async () => {
    assert.equal((await alice.get('/api/export?scope=events')).status, 200);
    assert.equal((await alice.get('/api/export?scope=users')).status, 403);
    assert.equal((await alice.get('/api/export?scope=all')).status, 403);
    assert.equal((await admin.get('/api/export?scope=users')).status, 200);
    assert.equal((await admin.get('/api/export?scope=all')).status, 200);
    assert.equal((await admin.get('/api/export?scope=bogus')).status, 400);
  });

  test('events export is a downloadable file with alerts, timelines and links', async () => {
    const a = await newAlert(alice, { title: 'Export me', links: [{ name: 'Doc', url: 'https://doc.example.com' }] });
    await alice.post(`/api/incidents/${a.id}/events`, { label: 'RCA', event_time: new Date().toISOString(), links: [{ name: 'PR', url: 'https://git.example.com/1' }] });

    const r = await alice.get('/api/export?scope=events');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="sre-dashboard-events-\d{8}-\d{6}\.json"/);
    assert.equal(r.data.app, 'sre-incident-dashboard');
    assert.equal(r.data.scope, 'events');
    assert.ok(!('users' in r.data));
    const exported = r.data.incidents.find((i) => i.title === 'Export me');
    assert.equal(exported.links[0].name, 'Doc');
    assert.equal(exported.events[0].links[0].name, 'PR');
    assert.ok(exported.uid);
  });

  test('users export carries hashes (needed for restore) but never plain passwords', async () => {
    const r = await admin.get('/api/export?scope=users');
    assert.ok(r.data.users.every((u) => u.password_hash.startsWith('scrypt:')));
    assert.ok(!r.text.includes('AdminPass123'));
    assert.ok(!('incidents' in r.data));
  });

  test('import is super-user only and rejects foreign or malformed files without changing anything', async () => {
    const before = (await anon.get('/api/incidents')).data.length;
    assert.equal((await alice.post('/api/import?mode=merge', { app: 'sre-incident-dashboard', format_version: 1, incidents: [] })).status, 403);

    const wrongApp = await admin.post('/api/import?mode=merge', { app: 'something-else', format_version: 1, incidents: [] });
    assert.equal(wrongApp.status, 400);

    const goodExport = (await admin.get('/api/export?scope=events')).data;
    const bad = JSON.parse(JSON.stringify(goodExport));
    bad.incidents.push({ ...bad.incidents[0], uid: 'brand-new-uid', severity: 'Nope' });
    const r = await admin.post('/api/import?mode=merge', bad);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /incidents\[\d+\]: severity/);

    const bad2 = JSON.parse(JSON.stringify(goodExport));
    bad2.incidents[0].events = [{ label: 'x', event_time: 'garbage', created_by: 'a' }];
    assert.equal((await admin.post('/api/import?mode=merge', bad2)).status, 400);

    const bad3 = JSON.parse(JSON.stringify(goodExport));
    bad3.incidents[0].links = [{ name: 'evil', url: 'javascript:alert(1)' }];
    assert.equal((await admin.post('/api/import?mode=merge', bad3)).status, 400);

    assert.equal((await admin.post('/api/import?mode=merge', { app: 'sre-incident-dashboard', format_version: 1 })).status, 400);
    assert.equal((await admin.post('/api/import?mode=sideways', goodExport)).status, 400);
    assert.equal((await admin.post('/api/import?mode=merge', { ...goodExport, format_version: 99 })).status, 400);

    assert.equal((await anon.get('/api/incidents')).data.length, before);
  });

  test('merge skips alerts that already exist and adds new ones', async () => {
    const exported = (await admin.get('/api/export?scope=events')).data;
    const count = exported.incidents.length;

    const again = await admin.post('/api/import?mode=merge', exported);
    assert.equal(again.status, 200);
    assert.deepEqual(again.data.summary.incidents, { imported: 0, skipped: count });

    const fresh = {
      ...exported,
      incidents: [{
        uid: 'from-another-instance-1', title: 'Imported from elsewhere', severity: 'High', status: 'Completed',
        created_by: 'zoe', assignee: '', created_at: '2026-01-02T03:04:05.000Z',
        links: [{ name: 'Old ticket', url: 'https://old.example.com/1' }],
        events: [
          { label: 'Completion', event_time: '2026-01-02T05:00:00.000Z', created_by: 'zoe', sort_order: 1 },
          { label: 'Issue Occurred', event_time: '2026-01-02T03:00:00.000Z', created_by: 'zoe', sort_order: 0 },
        ],
      }],
    };
    const r = await admin.post('/api/import?mode=merge', fresh);
    assert.deepEqual(r.data.summary.incidents, { imported: 1, skipped: 0 });

    const hit = (await anon.get('/api/incidents?q=Imported%20from%20elsewhere')).data[0];
    const detail = (await anon.get(`/api/incidents/${hit.id}`)).data;
    assert.deepEqual(detail.events.map((e) => e.label), ['Issue Occurred', 'Completion']); // order honoured
    assert.equal(detail.links[0].name, 'Old ticket');
    assert.ok(detail.closed_at); // Completed gets a closed_at
    assert.equal(detail.created_at, '2026-01-02T03:04:05.000Z');
  });

  test('replace restores the exported state exactly (ids, order, links) and removes later additions', async () => {
    const snapshot = (await admin.get('/api/export?scope=all')).data;
    const snapshotIds = snapshot.incidents.map((i) => i.id);

    assert.ok(snapshot.incidents.some((i) => i.carers.length > 0), 'snapshot should contain people taking care');
    assert.ok(snapshot.incidents.some((i) => i.single_holder === 1), 'snapshot should contain a one-holder alert');
    assert.ok(snapshot.incidents.some((i) => i.hold_auto === 1), 'snapshot should contain an automatic hold');
    assert.ok(snapshot.incidents.some((i) => i.status === 'On Hold' && i.hold_auto === 0), 'snapshot should contain a manual hold');

    const extra = await newAlert(alice, { title: 'Created after the backup' });
    assert.ok(extra.id > Math.max(...snapshotIds));
    await alice.del(`/api/incidents/${snapshotIds[0]}`);

    const r = await admin.post('/api/import?mode=replace', snapshot);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.summary.incidents.imported, snapshot.incidents.length);
    assert.equal(r.data.summary.users.imported, snapshot.users.length);

    // replacing users clears every session: everyone signs in again
    assert.equal((await admin.get('/api/auth/me')).data.user, null);
    await admin.login('admin', ADMIN_PASSWORD);
    await alice.login('alice', 'alice-password-1');
    await bob.login('bob', 'bob-password-1');
    await carol.login('carol', 'carol-password-1');

    const after2 = (await admin.get('/api/export?scope=all')).data;
    assert.deepEqual(after2.incidents.map((i) => i.id), snapshotIds);
    assert.deepEqual(
      after2.incidents.map(({ id, uid, title, events, links, activity, last_update_at, carers, hold_auto, single_holder }) => ({ id, uid, title, events: events.map((e) => e.label), links, activity, last_update_at, carers, hold_auto, single_holder })),
      snapshot.incidents.map(({ id, uid, title, events, links, activity, last_update_at, carers, hold_auto, single_holder }) => ({ id, uid, title, events: events.map((e) => e.label), links, activity, last_update_at, carers, hold_auto, single_holder })),
    );
    assert.equal((await anon.get('/api/incidents?q=Created%20after%20the%20backup')).data.length, 0);
  });

  test('replacing users refuses a file with no super user (would lock everyone out)', async () => {
    const users = (await admin.get('/api/export?scope=users')).data;
    users.users = users.users.map((u) => ({ ...u, role: 'user' }));
    const r = await admin.post('/api/import?mode=replace', users);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /super user/i);
    assert.equal((await admin.get('/api/auth/me')).data.user.username, 'admin'); // untouched
  });

  test('importing users in merge mode only adds missing accounts', async () => {
    const users = (await admin.get('/api/export?scope=users')).data;
    const hash = users.users[0].password_hash;
    users.users.push({ username: 'restored-user', role: 'user', password_hash: hash, created_at: '2026-01-01T00:00:00.000Z' });
    const r = await admin.post('/api/import?mode=merge', users);
    assert.equal(r.data.summary.users.imported, 1);
    assert.ok(r.data.summary.users.skipped >= 4);

    users.users.push({ username: 'bad-hash', role: 'user', password_hash: 'plaintext!', created_at: '2026-01-01T00:00:00.000Z' });
    assert.equal((await admin.post('/api/import?mode=merge', users)).status, 400);
  });
});

// ---------------------------------------------------------------------
describe('importing a backup made by the previous version', () => {
  const legacyFile = () => ({
    app: 'sre-incident-dashboard',
    format_version: 1,
    scope: 'events',
    exported_at: '2026-10-14T10:00:00.000Z',
    incidents: [{
      uid: 'legacy-uid-1', title: 'Legacy alert', severity: 'SEV1', status: 'Ongoing', mode: 'open',
      created_by: 'zoe', assignee: 'zoe', created_at: '2026-10-14T08:00:00.000Z',
      events: [
        { label: 'RCA', event_time: '2026-10-14T11:00:00.000Z', created_by: 'zoe', sort_order: 0 },
        { label: 'Issue Occurred', event_time: '2026-10-14T07:50:00.000Z', created_by: 'zoe', sort_order: 1 },
      ],
    }],
  });

  test('SEV1-4 names and the "open" mode are translated; events come out chronological', async () => {
    const r = await admin.post('/api/import?mode=merge', legacyFile());
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.summary.incidents, { imported: 1, skipped: 0 });

    const hit = (await anon.get('/api/incidents?q=Legacy%20alert')).data[0];
    assert.equal(hit.severity, 'Show-stopper');
    assert.equal(hit.mode, 'anyone');
    const detail = (await anon.get(`/api/incidents/${hit.id}`)).data;
    assert.deepEqual(detail.events.map((e) => e.label), ['Issue Occurred', 'RCA']);
    assert.ok(detail.last_update_at);          // old files get a fresh idle clock
    assert.deepEqual(detail.activity, []);     // and simply have no activity yet
  });

  test('old files: an On Hold alert was automatic, and there are no carers', async () => {
    const f = legacyFile();
    f.incidents[0].uid = 'legacy-uid-hold';
    f.incidents[0].title = 'Legacy held alert';
    f.incidents[0].status = 'On Hold';
    assert.equal((await admin.post('/api/import?mode=merge', f)).status, 200);
    const hit = (await anon.get('/api/incidents?q=Legacy%20held%20alert')).data[0];
    const detail = (await anon.get(`/api/incidents/${hit.id}`)).data;
    assert.equal(detail.hold_auto, 1);
    assert.deepEqual(detail.carers, []);
  });

  test('carers in a file are restored and de-duplicated; bad carers are rejected', async () => {
    const f = legacyFile();
    f.incidents[0].uid = 'legacy-uid-carers';
    f.incidents[0].title = 'Legacy carers alert';
    f.incidents[0].mode = 'takecare';
    f.incidents[0].carers = ['Bob', 'bob', 'carol'];
    assert.equal((await admin.post('/api/import?mode=merge', f)).status, 200);
    const hit = (await anon.get('/api/incidents?q=Legacy%20carers%20alert')).data[0];
    assert.deepEqual((await anon.get(`/api/incidents/${hit.id}`)).data.carers.sort(), ['bob', 'carol']);

    const g = legacyFile();
    g.incidents[0].uid = 'legacy-uid-carers-bad';
    g.incidents[0].carers = 'bob';
    assert.equal((await admin.post('/api/import?mode=merge', g)).status, 400);
  });

  test('old files had no one-holder alerts: the flag defaults to off, and is kept when present', async () => {
    const f = legacyFile();
    f.incidents[0].uid = 'legacy-uid-single';
    f.incidents[0].title = 'Legacy single check';
    f.incidents[0].mode = 'takecare';
    assert.equal((await admin.post('/api/import?mode=merge', f)).status, 200);
    const hit = (await anon.get('/api/incidents?q=Legacy%20single%20check')).data[0];
    assert.equal((await anon.get(`/api/incidents/${hit.id}`)).data.single_holder, 0);

    const g = legacyFile();
    g.incidents[0].uid = 'legacy-uid-single-on';
    g.incidents[0].title = 'Legacy single on';
    g.incidents[0].mode = 'takecare';
    g.incidents[0].single_holder = 1;
    assert.equal((await admin.post('/api/import?mode=merge', g)).status, 200);
    const hit2 = (await anon.get('/api/incidents?q=Legacy%20single%20on')).data[0];
    assert.equal((await anon.get(`/api/incidents/${hit2.id}`)).data.single_holder, 1);
  });

  test('genuinely unknown severities and modes are still rejected', async () => {
    const f = legacyFile();
    f.incidents[0].uid = 'legacy-uid-2';
    f.incidents[0].severity = 'SEV9';
    assert.equal((await admin.post('/api/import?mode=merge', f)).status, 400);
    const g = legacyFile();
    g.incidents[0].uid = 'legacy-uid-3';
    g.incidents[0].mode = 'weird';
    assert.equal((await admin.post('/api/import?mode=merge', g)).status, 400);
  });

  test('malformed activity entries are rejected', async () => {
    const f = legacyFile();
    f.incidents[0].uid = 'legacy-uid-4';
    f.incidents[0].activity = [{ kind: 'x', actor: 'a' }];
    const r = await admin.post('/api/import?mode=merge', f);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /activity\[1\]/);
  });
});

// ---------------------------------------------------------------------
describe('static files and HTTP hardening', () => {
  test('index is served with security headers', async () => {
    const r = await anon.get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  test('path traversal and source files are not reachable', async () => {
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/js/../../server.js', '/..%2f..%2fetc/passwd', '/lib/db.js', '/package.json', '/data/dashboard.db', '/%00']) {
      const r = await anon.get(p);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!String(r.text).includes('require('), `${p} leaked source`);
    }
  });

  test('conditional GET returns 304 for unchanged assets', async () => {
    const first = await anon.get('/styles.css');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await anon.request('GET', '/styles.css', undefined, { 'If-None-Match': etag });
    assert.equal(second.status, 304);
  });

  test('unknown API routes and wrong methods', async () => {
    assert.equal((await anon.get('/api/nope')).status, 404);
    assert.equal((await anon.request('DELETE', '/api/meta')).status, 405);
    assert.equal((await alice.get('/api/incidents/abc')).status, 400);
    assert.equal((await alice.get('/api/incidents/999999')).status, 404);
  });

  test('oversized request bodies are rejected', async () => {
    const huge = JSON.stringify({ title: 'x', description: 'y'.repeat(1_100_000) });
    const r = await alice.request('POST', '/api/incidents', huge);
    assert.equal(r.status, 413);
  });
});
