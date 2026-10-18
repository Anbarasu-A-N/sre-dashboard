'use strict';

// Must be required BEFORE anything from ../server so the temp DB is used.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sre-test-'));
process.env.DATA_DIR = dataDir;
process.env.QUIET = '1';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'AdminPass123';

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async request(method, url, body, headers = {}) {
    const res = await fetch(this.base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      redirect: 'manual',
    });

    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      this.cookie = /Max-Age=0/i.test(c) ? '' : pair;
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers, text, setCookie };
  }

  get(url) { return this.request('GET', url); }
  post(url, body = {}) { return this.request('POST', url, body); }
  patch(url, body) { return this.request('PATCH', url, body); }
  put(url, body) { return this.request('PUT', url, body); }
  del(url) { return this.request('DELETE', url); }

  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.status} ${JSON.stringify(r.data)}`);
    return r;
  }
}

async function boot() {
  // Loaded lazily so a test can prepare files in DATA_DIR before the DB is opened.
  const { createServer, ensureInitialAdmin } = require('../server');
  await ensureInitialAdmin();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    client: () => new Client(base),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

module.exports = { boot, Client, dataDir, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
