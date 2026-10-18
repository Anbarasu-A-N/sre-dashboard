'use strict';

const h = require('./helpers');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
before(async () => { app = await h.boot(); });
after(async () => { await app.close(); });

describe('login throttling', () => {
  test('repeated failures lock the client out, even for the right password, until the window passes', async () => {
    const c = app.client();
    for (let i = 0; i < 10; i++) {
      const r = await c.post('/api/auth/login', { username: 'admin', password: 'wrong-wrong-wrong' });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await c.post('/api/auth/login', { username: 'admin', password: h.ADMIN_PASSWORD });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /Too many failed sign-in attempts/);
  });

  test('a successful login resets the counter', async () => {
    const { LoginLimiter } = require('../lib/auth');
    const limiter = new LoginLimiter(3, 60000);
    limiter.fail('ip'); limiter.fail('ip');
    limiter.reset('ip');
    limiter.fail('ip'); limiter.fail('ip');
    assert.doesNotThrow(() => limiter.check('ip'));
    limiter.fail('ip');
    assert.throws(() => limiter.check('ip'), /Too many/);
    assert.doesNotThrow(() => limiter.check('other-ip'));
  });
});
