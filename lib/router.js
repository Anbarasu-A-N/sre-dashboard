'use strict';

class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

const json = (data, status = 200, headers = {}) => new Reply(status, data, headers);

class Router {
  constructor() {
    this.routes = [];
  }

  // auth: 'none' | 'user' | 'superuser'
  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const names = [];
    const source = pattern.replace(/:([a-zA-Z_]+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
    this.routes.push({
      method,
      regex: new RegExp(`^${source}$`),
      names,
      auth: opts.auth || 'none',
      maxBody: opts.maxBody,
      broadcast: opts.broadcast !== false, // a successful write pings every open browser (see realtime.js)
      handler,
    });
  }

  // Returns { route, params } | { methodNotAllowed: true } | null
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router, Reply, json };
