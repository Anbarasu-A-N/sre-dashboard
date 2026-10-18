'use strict';

// Plain child processes with their own DATA_DIR: first-run default password and the recovery CLI.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const cleanEnv = (extra) => {
  const env = { ...process.env, QUIET: '1', ...extra };
  delete env.ADMIN_PASSWORD;
  delete env.ADMIN_USERNAME;
  return { ...env, ...extra };
};
const node = (args, env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: root, env, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sre-defaults-'));

const probe = `
  const s = require('./server'); const store = require('./lib/store'); const auth = require('./lib/auth');
  (async () => {
    const first = await s.ensureInitialAdmin();
    const again = await s.ensureInitialAdmin();
    const u = store.getUserByUsername(process.env.PROBE_USER || 'admin');
    const out = { first, again, flag: u.must_change_password, role: u.role };
    for (const pw of ['admin123', 'something-else-1']) out[pw] = await auth.verifyPassword(pw, u.password_hash);
    console.log(JSON.stringify(out));
  })();`;

describe('first-run super user', () => {
  test('defaults to admin / admin123 and is flagged so the UI asks for a change', () => {
    const r = node(['-e', probe], cleanEnv({ DATA_DIR: tmp() }));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.first, { username: 'admin', password: 'admin123', isDefault: true });
    assert.equal(out.again, null);            // only ever created once
    assert.equal(out.flag, 1);
    assert.equal(out.role, 'superuser');
    assert.equal(out['admin123'], true);
  });

  test('ADMIN_PASSWORD / ADMIN_USERNAME override it, and then nothing is flagged', () => {
    const r = node(['-e', probe], cleanEnv({ DATA_DIR: tmp(), ADMIN_PASSWORD: 'something-else-1', ADMIN_USERNAME: 'root-admin', PROBE_USER: 'root-admin' }));
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.first.isDefault, false);
    assert.equal(out.flag, 0);
    assert.equal(out['admin123'], false);
    assert.equal(out['something-else-1'], true);
  });
});

describe('scripts/reset-password.js (recovery for an existing database)', () => {
  const run = (dir, ...args) => node(['scripts/reset-password.js', ...args], cleanEnv({ DATA_DIR: dir }));
  const check = (dir, user, pw) => {
    const code = `const s=require('./lib/store'),a=require('./lib/auth');const u=s.getUserByUsername('${user}');
      (async()=>console.log(JSON.stringify({ok:u?await a.verifyPassword('${pw}',u.password_hash):null,flag:u&&u.must_change_password,role:u&&u.role})))()`;
    return JSON.parse(node(['-e', code], cleanEnv({ DATA_DIR: dir })).stdout.trim().split('\n').pop());
  };

  test('resets an existing user to admin123 by default and flags it', () => {
    const dir = tmp();
    node(['-e', probe], cleanEnv({ DATA_DIR: dir, ADMIN_PASSWORD: 'long-forgotten-pw' }));   // like your current EC2 admin
    assert.equal(check(dir, 'admin', 'admin123').ok, false);
    const r = run(dir, 'admin');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /reset/i);
    assert.deepEqual(check(dir, 'admin', 'admin123'), { ok: true, flag: 1, role: 'superuser' });
  });

  test('accepts a chosen password, and --create makes a missing super user', () => {
    const dir = tmp();
    node(['-e', probe], cleanEnv({ DATA_DIR: dir }));
    assert.equal(run(dir, 'admin', 'my-new-pass-9').status, 0);
    assert.equal(check(dir, 'admin', 'my-new-pass-9').ok, true);

    assert.equal(run(dir, 'ghost').status, 1);                       // refuses to invent users silently
    const made = run(dir, 'rescue', 'rescue-pass-1', '--create');
    assert.equal(made.status, 0, made.stderr);
    assert.deepEqual(check(dir, 'rescue', 'rescue-pass-1'), { ok: true, flag: 1, role: 'superuser' });
  });

  test('rejects weak passwords and missing arguments', () => {
    const dir = tmp();
    node(['-e', probe], cleanEnv({ DATA_DIR: dir }));
    assert.equal(run(dir, 'admin', 'short').status, 1);
    assert.equal(run(dir).status, 2);
  });
});
