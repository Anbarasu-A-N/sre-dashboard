'use strict';

const h = require('./helpers');
const http = require('node:http');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
let admin;
let alice;
let bob;
const open = [];

// Minimal Server-Sent Events reader.
function openStream(cookie) {
  return new Promise((resolve, reject) => {
    const events = [];
    let raw = '';
    const req = http.get(`${app.base}/api/stream`, { headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        raw += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^event: (\w+)/m.exec(block);
          if (m) events.push(m[1]);
        }
      });
      const stream = { events, status: res.statusCode, headers: res.headers, raw: () => raw, count: (t) => events.filter((e) => e === t).length, close: () => req.destroy() };
      open.push(stream);
      resolve(stream);
    });
    req.on('error', reject);
  });
}

const until = async (fn, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const settle = () => new Promise((r) => setTimeout(r, 150)); // long enough for a stray ping to show up

before(async () => {
  app = await h.boot();
  admin = app.client(); alice = app.client(); bob = app.client();
  await admin.login('admin', h.ADMIN_PASSWORD);
  await admin.post('/api/users', { username: 'alice', password: 'alice-password-1' });
  await admin.post('/api/users', { username: 'bob', password: 'bob-password-1' });
  await alice.login('alice', 'alice-password-1');
  await bob.login('bob', 'bob-password-1');
});
after(async () => { open.forEach((s) => s.close()); await app.close(); });

describe('live updates (server-sent events)', () => {
  test('anyone can listen, including anonymous visitors; the stream says hello and has the right headers', async () => {
    const s = await openStream();
    assert.equal(s.status, 200);
    assert.match(s.headers['content-type'], /text\/event-stream/);
    assert.match(s.headers['cache-control'], /no-cache/);
    assert.equal(s.headers['x-accel-buffering'], 'no');           // keeps nginx from buffering it
    assert.ok(await until(() => s.count('hello') === 1));
  });

  test('a new alert pings everybody, so other people see it without refreshing', async () => {
    const anon = await openStream();
    const bobStream = await openStream(bob.cookie);
    const aliceStream = await openStream(alice.cookie);
    await until(() => anon.count('hello') && bobStream.count('hello') && aliceStream.count('hello'));

    const r = await alice.post('/api/incidents', { title: 'Visible everywhere', severity: 'High' });
    assert.equal(r.status, 201);
    for (const s of [anon, bobStream, aliceStream]) assert.ok(await until(() => s.count('data') >= 1));
  });

  test('every kind of successful change pings: edit, assign, take care, events, delete', async () => {
    const watcher = await openStream();
    await until(() => watcher.count('hello'));
    const a = (await alice.post('/api/incidents', { title: 'Pings', severity: 'High' })).data;
    await until(() => watcher.count('data') >= 1);

    let expected = watcher.count('data');
    const expectPing = async (label, action) => {
      const r = await action();
      assert.ok(r.status < 300, `${label}: ${r.status}`);
      expected += 1;
      assert.ok(await until(() => watcher.count('data') >= expected), `${label} should ping`);
    };
    await expectPing('edit', () => alice.patch(`/api/incidents/${a.id}`, { status: 'Monitoring' }));
    await expectPing('assign', () => alice.post(`/api/incidents/${a.id}/assign`, { assignee: 'bob' }));
    await expectPing('take care', () => bob.post(`/api/incidents/${a.id}/care`).then(() => admin.post(`/api/incidents/${a.id}/care`)));
    await expectPing('add event', () => alice.post(`/api/incidents/${a.id}/events`, { label: 'Update', event_time: new Date().toISOString() }));
    await expectPing('delete', () => alice.del(`/api/incidents/${a.id}`));
  });

  test('reads, logins, failed writes and "mark as read" do NOT ping', async () => {
    const watcher = await openStream();
    await until(() => watcher.count('hello'));
    await settle();
    const before = watcher.count('data');

    await alice.get('/api/incidents');
    await alice.get('/api/dashboard');
    await app.client().post('/api/auth/login', { username: 'alice', password: 'wrong-password-1' }); // fails
    await app.client().login('bob', 'bob-password-1');                                                 // succeeds, shares nothing
    await bob.post('/api/incidents/999999/events', { label: 'x', event_time: new Date().toISOString() }); // 404
    await bob.patch('/api/incidents/1', { title: 'nope' });                                           // 403 or 404
    await app.client().post('/api/incidents', { title: 'anonymous write' });                          // 401
    await bob.post('/api/notifications/read', { all: true });
    await settle();
    assert.equal(watcher.count('data'), before);
  });

  test('"notify" goes only to the people who got a notification, never to the creator or to visitors', async () => {
    const anon = await openStream();
    const aliceStream = await openStream(alice.cookie);
    const bobStream = await openStream(bob.cookie);
    await until(() => anon.count('hello') && aliceStream.count('hello') && bobStream.count('hello'));

    await alice.post('/api/incidents', { title: 'Needs a taker', mode: 'takecare' });
    assert.ok(await until(() => bobStream.count('notify') === 1));
    await settle();
    assert.equal(aliceStream.count('notify'), 0);   // she created it
    assert.equal(anon.count('notify'), 0);          // not signed in

    const before = bobStream.count('notify');
    await alice.post('/api/incidents', { title: 'Private one', mode: 'private' });          // no notification for these
    await alice.post('/api/incidents', { title: 'Anyone one', mode: 'anyone' });
    await settle();
    assert.equal(bobStream.count('notify'), before);
  });

  test('the stream carries only pings: no alert content ever travels over it', async () => {
    const anon = await openStream();
    await until(() => anon.count('hello'));
    await alice.post('/api/incidents', { title: 'SECRET-TITLE-XYZ', description: 'SECRET-BODY', mode: 'takecare', links: [{ name: 'SECRET-LINK', url: 'https://secret.example.com' }] });
    await until(() => anon.count('data') >= 1);
    const text = anon.raw();
    assert.ok(!/SECRET/i.test(text), text);
    assert.ok(!text.includes('alice'));
    for (const line of text.split('\n').filter(Boolean)) {
      assert.match(line, /^(retry: \d+|event: \w+|data: \{\}|: ping)$/);
    }
  });

  test('closing the tab cleans up the connection; other methods are refused', async () => {
    const realtime = require('../lib/realtime');
    const s = await openStream();
    await until(() => s.count('hello'));
    const connected = realtime.connectionCount();
    s.close();
    assert.ok(await until(() => realtime.connectionCount() < connected));
    assert.equal((await alice.post('/api/stream', {})).status, 405);
  });

  test('a signed-out stream is told to refresh like anyone else, and keeps working after a restart of the browser side', async () => {
    const a = await openStream();
    await until(() => a.count('hello'));
    a.close();
    const b = await openStream(bob.cookie);                         // a "reconnect"
    await until(() => b.count('hello'));
    await alice.post('/api/incidents', { title: 'After reconnect' });
    assert.ok(await until(() => b.count('data') >= 1));
  });
});
