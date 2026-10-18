'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./lib/config');
const { db } = require('./lib/db');
const auth = require('./lib/auth');
const store = require('./lib/store');
const backup = require('./lib/backup');
const realtime = require('./lib/realtime');
const v = require('./lib/validation');
const { incidentPermissions, isSuper, same } = require('./lib/permissions');
const { HttpError, bad, forbidden, notFound, conflict } = require('./lib/errors');
const { Router, Reply, json } = require('./lib/router');

const { LIMITS, MODES, ROLES, SEVERITY_VALUES, STATUS_VALUES, MODE_LABEL, AUTO_STATUS, DEFAULT_ADMIN_PASSWORD } = config;
const PUBLIC_DIR = path.join(__dirname, 'public');

const router = new Router();
const loginLimiter = new auth.LoginLimiter();

// ====================================================================
// Helpers
// ====================================================================

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, mustChangePassword: !!u.must_change_password });
const present = (incident, user) => ({ ...incident, permissions: incidentPermissions(incident, user) });

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loadIncident(rawId) {
  const incident = store.getIncident(v.id(rawId, 'alert id'));
  if (!incident) throw notFound('Alert not found');
  return incident;
}

function requireExistingUser(name) {
  const user = store.getUserByUsername(v.username(name));
  if (!user) throw bad(`User "${String(name).trim()}" does not exist`);
  return user;
}

function clientIp(req) {
  if (config.TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ====================================================================
// Public routes
// ====================================================================

router.add('GET', '/healthz', () => ({ ok: true }));

router.add('GET', '/api/meta', () => config.META);

router.add('GET', '/api/dashboard', (ctx) => {
  const days = clampInt(ctx.query.get('days'), 14, 1, 90);
  const offsetMin = clampInt(ctx.query.get('tz'), 0, -840, 840);
  return store.dashboardData({ days, offsetMin });
});

router.add('GET', '/api/incidents', (ctx) => {
  const text = (name) => (ctx.query.get(name) || '').trim().slice(0, 200) || undefined;
  const wantsMine = ctx.query.get('mine') === '1';
  if (wantsMine && !ctx.user) throw new HttpError(401, 'Please sign in to see your alerts');
  return store.listIncidents({
    mine: wantsMine ? ctx.user.username : undefined,
    status: text('status'),
    severity: text('severity'),
    assignee: text('assignee'),
    created_by: text('created_by'),
    active: ctx.query.get('active') === '1',
    q: text('q'),
  });
});

router.add('GET', '/api/incidents/:id', (ctx) => present(loadIncident(ctx.params.id), ctx.user));

// ====================================================================
// Auth
// ====================================================================

router.add('GET', '/api/auth/me', (ctx) => ({ user: ctx.user ? publicUser(ctx.user) : null }));

router.add('POST', '/api/auth/login', { broadcast: false }, async (ctx) => {
  loginLimiter.check(ctx.ip);

  const username = typeof ctx.body.username === 'string' ? ctx.body.username.trim().toLowerCase() : '';
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  const row = username ? store.getUserByUsername(username) : null;

  let ok = false;
  if (password.length <= LIMITS.passwordMax) {
    if (row) ok = await auth.verifyPassword(password, row.password_hash);
    else await auth.verifyAgainstDummy(password);
  }
  if (!ok) {
    loginLimiter.fail(ctx.ip);
    throw new HttpError(401, 'Incorrect username or password');
  }

  loginLimiter.reset(ctx.ip);
  const { token, maxAgeSeconds } = auth.createSession(row.id);
  return json({ user: publicUser(row) }, 200, { 'Set-Cookie': auth.setSessionCookie(token, maxAgeSeconds) });
});

router.add('POST', '/api/auth/logout', { broadcast: false }, (ctx) => {
  auth.destroySession(ctx.sessionToken);
  return new Reply(204, undefined, { 'Set-Cookie': auth.clearSessionCookie() });
});

router.add('POST', '/api/auth/password', { auth: 'user', broadcast: false }, async (ctx) => {
  const row = store.getUserById(ctx.user.id);
  const current = typeof ctx.body.current_password === 'string' ? ctx.body.current_password : '';
  if (!(await auth.verifyPassword(current, row.password_hash))) throw bad('Current password is incorrect');

  const next = v.password(ctx.body.new_password, 'New password');
  const hash = await auth.hashPassword(next);
  store.setUserPasswordHash(row.id, hash, false);
  auth.destroyUserSessions(row.id, ctx.sessionToken); // sign out other devices
  return { ok: true };
});

// ====================================================================
// Users
// ====================================================================

// Usernames + roles only: any signed-in user needs this to assign alerts.
router.add('GET', '/api/users/directory', { auth: 'user' }, () => store.userDirectory());

router.add('GET', '/api/users', { auth: 'superuser' }, () => store.listUsers());

router.add('POST', '/api/users', { auth: 'superuser' }, async (ctx) => {
  const username = v.username(ctx.body.username);
  const password = v.password(ctx.body.password);
  const role = ctx.body.role === undefined ? 'user' : v.oneOf(ctx.body.role, ROLES, 'role');
  const hash = await auth.hashPassword(password);

  if (store.getUserByUsername(username)) throw conflict(`Username "${username}" is already taken`);
  return json(store.createUser({ username, password_hash: hash, role, must_change: true }), 201);
});

router.add('PATCH', '/api/users/:id', { auth: 'superuser' }, async (ctx) => {
  const target = store.getUserById(v.id(ctx.params.id, 'user id'));
  if (!target) throw notFound('User not found');

  let newHash;
  if (ctx.body.password !== undefined) newHash = await auth.hashPassword(v.password(ctx.body.password));

  if (ctx.body.role !== undefined) {
    const role = v.oneOf(ctx.body.role, ROLES, 'role');
    if (target.role === 'superuser' && role !== 'superuser' && store.countSuperusers() <= 1) {
      throw conflict('There must always be at least one super user');
    }
    store.setUserRole(target.id, role);
  }
  if (newHash) {
    store.setUserPasswordHash(target.id, newHash, true); // a password set by an admin is temporary
    auth.destroyUserSessions(target.id);
  }
  const { id, username, role, created_at, must_change_password } = store.getUserById(target.id);
  return { id, username, role, created_at, must_change_password };
});

router.add('DELETE', '/api/users/:id', { auth: 'superuser' }, (ctx) => {
  const target = store.getUserById(v.id(ctx.params.id, 'user id'));
  if (!target) throw notFound('User not found');
  if (target.id === ctx.user.id) throw conflict('You cannot delete your own account');
  if (target.role === 'superuser' && store.countSuperusers() <= 1) throw conflict('There must always be at least one super user');
  store.deleteUser(target.id);
  return undefined;
});

// ====================================================================
// Alerts (incidents)
// ====================================================================

router.add('POST', '/api/incidents', { auth: 'user' }, (ctx) => {
  const b = ctx.body;
  const mode = b.mode === undefined ? config.META.defaultMode : v.oneOf(b.mode, MODES, 'mode');

  let assignee;
  if (mode === 'private') assignee = ctx.user.username;             // only the creator continues
  else if (b.assignee === undefined || b.assignee === null) assignee = ctx.user.username; // default: me
  else if (b.assignee === '') assignee = '';                         // unassigned: anyone can take care
  else assignee = requireExistingUser(b.assignee).username;

  const incident = store.createIncident(ctx.user, {
    title: v.str(b.title, 'title', { required: true, max: LIMITS.title }),
    description: v.str(b.description, 'description', { max: LIMITS.description }),
    severity: b.severity === undefined ? config.META.defaultSeverity : v.oneOf(b.severity, SEVERITY_VALUES, 'severity'),
    mode,
    assignee,
    links: b.links === undefined ? [] : v.links(b.links),
  });

  // "Assigned with take care" alerts tell everybody else, so someone can take care of them.
  if (mode === 'takecare') realtime.notifyUsers(store.notifyNewTakecareAlert(incident, ctx.user));

  return json(present(incident, ctx.user), 201);
});

router.add('PATCH', '/api/incidents/:id', { auth: 'user' }, (ctx) => {
  const incident = loadIncident(ctx.params.id);
  const perms = incidentPermissions(incident, ctx.user);
  const b = ctx.body;

  const editsContent = ['title', 'description', 'severity', 'status', 'links'].some((k) => b[k] !== undefined);
  if (editsContent && !perms.canEdit) throw forbidden('Only the creator, the assignee or a super user can edit this alert');
  if (b.mode !== undefined && !perms.canChangeMode) throw forbidden('Only the creator or a super user can change who can continue this alert');

  const patch = {};
  if (b.title !== undefined) patch.title = v.str(b.title, 'title', { required: true, max: LIMITS.title });
  if (b.description !== undefined) patch.description = v.str(b.description, 'description', { max: LIMITS.description });
  if (b.severity !== undefined) patch.severity = v.oneOf(b.severity, SEVERITY_VALUES, 'severity');
  if (b.status !== undefined) patch.status = v.oneOf(b.status, STATUS_VALUES, 'status'); // On Hold is allowed by hand too
  if (b.mode !== undefined) patch.mode = v.oneOf(b.mode, MODES, 'mode');
  if (b.links !== undefined) patch.links = v.links(b.links);

  return present(store.updateIncident(incident.id, patch, ctx.user), ctx.user);
});

router.add('POST', '/api/incidents/:id/assign', { auth: 'user' }, (ctx) => {
  const incident = loadIncident(ctx.params.id);
  const perms = incidentPermissions(incident, ctx.user);
  const actor = ctx.user.username;
  const previous = incident.assignee;
  const was = previous && !same(previous, actor) ? ` (was ${previous})` : '';

  if (incident.mode === 'private') {
    throw conflict('This alert is "Only me": it belongs to its creator. Change who can continue it before assigning it.');
  }
  if (typeof ctx.body.assignee !== 'string') throw bad('assignee is required (use an empty string to unassign)');

  const name = ctx.body.assignee.trim();

  // ---- unassign
  if (name === '') {
    if (!perms.canAssign) throw forbidden('Only the creator, the assignee or a super user can unassign this alert');
    if (!previous) return present(incident, ctx.user);
    return present(store.assignIncident(incident.id, '', {
      kind: 'unassigned', actor, text: `${actor} unassigned this alert${was}`,
    }), ctx.user);
  }

  const target = requireExistingUser(name);
  if (same(target.username, previous)) return present(incident, ctx.user); // nothing to change
  const toSelf = same(target.username, actor);

  // ---- assign to yourself (creator/assignee/super user, or anyone for an unassigned "anyone" alert)
  if (toSelf && (perms.canAssign || perms.canAssignSelf)) {
    return present(store.assignIncident(incident.id, target.username, {
      kind: 'assigned', actor, text: `${actor} assigned this alert to themselves${was}`,
    }), ctx.user);
  }

  // ---- assign someone else
  if (!perms.canAssign) {
    if (toSelf && incident.status === 'Completed') throw forbidden('Completed alerts cannot be assigned to yourself');
    if (previous) {
      throw forbidden(`This alert is assigned to ${previous}. Only ${previous}, the creator or a super user can change the assignment or the status.${incident.mode === 'takecare' ? ' You can press "Take care" to add timeline events.' : ''}`);
    }
    throw forbidden(incident.mode === 'takecare'
      ? 'Only the creator, the assignee or a super user can assign this alert to someone else. You can press "Take care" to add timeline events.'
      : 'You cannot assign this alert to someone else');
  }
  return present(store.assignIncident(incident.id, target.username, {
    kind: 'assigned', actor, text: `${actor} assigned this alert to ${target.username}${was}`,
  }), ctx.user);
});

// ---- Take care: lets you ADD timeline events. You are not assigned and are never asked to assign.
router.add('POST', '/api/incidents/:id/care', { auth: 'user' }, (ctx) => {
  const incident = loadIncident(ctx.params.id);
  const perms = incidentPermissions(incident, ctx.user);
  if (incident.mode !== 'takecare') {
    throw conflict(`Take care is only available on alerts set to "${MODE_LABEL.takecare}"`);
  }
  if (perms.canLeaveCare || perms.canEdit) return present(incident, ctx.user); // already able to add events
  if (incident.status === 'Completed') throw forbidden('Completed alerts cannot be taken care of');
  if (!perms.canTakeCare) throw forbidden('You cannot take care of this alert');
  return present(store.addCarer(incident.id, ctx.user.username, ctx.user.username), ctx.user);
});

// Stop taking care. With ?user=name the creator, the assignee or a super user can release somebody else.
router.add('DELETE', '/api/incidents/:id/care', { auth: 'user' }, (ctx) => {
  const incident = loadIncident(ctx.params.id);
  const wanted = ctx.query.get('user');
  const who = wanted ? v.username(wanted) : ctx.user.username;
  if (!same(who, ctx.user.username) && !incidentPermissions(incident, ctx.user).canAssign) {
    throw forbidden('Only the creator, the assignee or a super user can release somebody else');
  }
  return present(store.removeCarer(incident.id, who, ctx.user.username), ctx.user);
});

router.add('DELETE', '/api/incidents/:id', { auth: 'user' }, (ctx) => {
  const incident = loadIncident(ctx.params.id);
  if (!incidentPermissions(incident, ctx.user).canDelete) throw forbidden('Only the creator or a super user can delete this alert');
  store.deleteIncident(incident.id);
  return undefined;
});

// ====================================================================
// Timeline events
// ====================================================================

router.add('POST', '/api/incidents/:id/events', { auth: 'user' }, (ctx) => {
  const incident = loadIncident(ctx.params.id);
  if (!incidentPermissions(incident, ctx.user).canAddEvent) {
    throw forbidden('Only the creator, the assignee, a super user or someone taking care of this alert can add timeline events.');
  }
  const b = ctx.body;
  const event = store.addEvent(incident.id, ctx.user, {
    label: v.str(b.label, 'label', { required: true, max: LIMITS.label }),
    event_time: v.isoDate(b.event_time, 'event_time'),
    note: v.str(b.note, 'note', { max: LIMITS.note }),
    links: b.links === undefined ? [] : v.links(b.links),
  });
  return json(event, 201);
});

function loadEventWithIncident(rawId) {
  const event = store.getEvent(v.id(rawId, 'event id'));
  if (!event) throw notFound('Event not found');
  return { event, incident: loadIncident(event.incident_id) };
}

router.add('PATCH', '/api/events/:id', { auth: 'user' }, (ctx) => {
  const { event, incident } = loadEventWithIncident(ctx.params.id);
  if (!incidentPermissions(incident, ctx.user).canEdit) throw forbidden('You cannot edit this timeline');
  const b = ctx.body;
  const patch = {};
  if (b.label !== undefined) patch.label = v.str(b.label, 'label', { required: true, max: LIMITS.label });
  if (b.event_time !== undefined) patch.event_time = v.isoDate(b.event_time, 'event_time');
  if (b.note !== undefined) patch.note = v.str(b.note, 'note', { max: LIMITS.note });
  if (b.links !== undefined) patch.links = v.links(b.links);
  return store.updateEvent(event.id, patch, ctx.user);
});

router.add('DELETE', '/api/events/:id', { auth: 'user' }, (ctx) => {
  const { event, incident } = loadEventWithIncident(ctx.params.id);
  if (!incidentPermissions(incident, ctx.user).canEdit) throw forbidden('You cannot edit this timeline');
  store.deleteEvent(event.id);
  return undefined;
});

// ====================================================================
// Notifications (the bell)
// ====================================================================

router.add('GET', '/api/notifications', { auth: 'user' }, (ctx) => store.listNotifications(ctx.user.id));

router.add('POST', '/api/notifications/read', { auth: 'user', broadcast: false }, (ctx) => {
  const all = ctx.body.all === true;
  let ids = [];
  if (!all) {
    if (!Array.isArray(ctx.body.ids)) throw bad('Send {"ids": [...]} or {"all": true}');
    ids = ctx.body.ids.map((x) => v.id(x, 'notification id'));
  }
  return { unread: store.markNotificationsRead(ctx.user.id, { ids, all }) };
});

// ====================================================================
// Backup: export / import
// ====================================================================

router.add('GET', '/api/export', { auth: 'user' }, (ctx) => {
  const scope = ctx.query.get('scope') || 'events';
  if (scope !== 'events' && !isSuper(ctx.user)) {
    throw forbidden('Only super users can export users or the full data set');
  }
  const data = backup.exportData(scope);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return new Reply(200, JSON.stringify(data, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="sre-dashboard-${scope}-${stamp}.json"`,
  });
});

router.add('POST', '/api/import', { auth: 'superuser', maxBody: config.IMPORT_BODY_LIMIT }, (ctx) => {
  const mode = ctx.query.get('mode') || 'merge';
  return { ok: true, mode, summary: backup.importData(ctx.body, mode) };
});

// ====================================================================
// HTTP plumbing
// ====================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, 'Request body too large'));

    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) { rejected = true; chunks.length = 0; reject(new HttpError(413, 'Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      if (chunks.length === 0) return resolve({});
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(bad('Invalid JSON body')); }
      if (parsed === null || typeof parsed !== 'object') return reject(bad('Request body must be a JSON object'));
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

// Blocks cross-site form/fetch attacks on top of SameSite cookies.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw forbidden('Cross-origin request blocked'); }
  const allowed = [req.headers.host];
  if (config.TRUST_PROXY && req.headers['x-forwarded-host']) allowed.push(String(req.headers['x-forwarded-host']).split(',')[0].trim());
  if (!allowed.includes(host)) throw forbidden('Cross-origin request blocked');
}

function sendReply(res, reply) {
  const headers = { ...reply.headers };
  let payload = null;
  if (reply.body !== undefined && reply.body !== null) {
    if (typeof reply.body === 'string' || Buffer.isBuffer(reply.body)) {
      payload = reply.body;
    } else {
      payload = JSON.stringify(reply.body);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  headers['Cache-Control'] = headers['Cache-Control'] || 'no-store';
  res.writeHead(reply.status, headers);
  res.end(payload);
}

function sendError(res, err) {
  if (res.headersSent) return res.end();
  let status = 500;
  let message = 'Internal server error';
  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else {
    console.error(err);
  }
  const headers = {};
  if (status === 413) headers.Connection = 'close';
  sendReply(res, new Reply(status, { error: message }, headers));
}

async function handleApi(req, res, url, ctx) {
  const method = req.method;
  const matched = router.match(method, url.pathname);
  if (!matched) throw notFound('Not found');
  if (matched.methodNotAllowed) throw new HttpError(405, 'Method not allowed');

  const { route, params } = matched;
  if (method !== 'GET') checkOrigin(req);
  if (route.auth !== 'none' && !ctx.user) throw new HttpError(401, 'Please sign in to do that');
  if (route.auth === 'superuser' && !isSuper(ctx.user)) throw forbidden('Super user access required');

  ctx.params = params;
  ctx.query = url.searchParams;
  ctx.body = ['POST', 'PUT', 'PATCH'].includes(method)
    ? await readJsonBody(req, route.maxBody || config.BODY_LIMIT)
    : {};

  const result = await route.handler(ctx);
  if (method !== 'GET' && route.broadcast) realtime.broadcastData();
  if (result instanceof Reply) return sendReply(res, result);
  if (result === undefined) return sendReply(res, new Reply(204));
  return sendReply(res, new Reply(200, result));
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw bad('Bad URL'); }
  if (rel.includes('\0')) throw bad('Bad URL');
  if (rel === '/') rel = '/index.html';

  const full = path.resolve(PUBLIC_DIR, `.${rel}`);
  const base = path.basename(full);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) throw forbidden('Forbidden');
  if (base.startsWith('.') || base === 'package.json') throw notFound('Not found');

  let stat;
  try { stat = fs.statSync(full); } catch { throw notFound('Not found'); }
  if (!stat.isFile()) throw notFound('Not found');

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).pipe(res);
}

async function handleRequest(req, res) {
  const started = Date.now();
  const ctx = { req, res, ip: clientIp(req), user: null, sessionToken: null };
  let pathname = req.url;

  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;

    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      ctx.sessionToken = auth.parseCookies(req.headers.cookie)[config.COOKIE_NAME] || null;
      ctx.user = auth.getUserBySession(ctx.sessionToken);
      if (pathname === '/api/stream') {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        realtime.addClient(req, res, ctx.user);
      } else {
        await handleApi(req, res, url, ctx);
      }
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    sendError(res, err);
  } finally {
    if (!config.QUIET && !pathname.startsWith('/js/') && pathname !== '/styles.css') {
      const who = ctx.user ? ` user=${ctx.user.username}` : '';
      console.log(`${new Date().toISOString()} ${ctx.ip} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms${who}`);
    }
  }
}

function createServer() {
  return http.createServer(handleRequest);
}

// ====================================================================
// Startup
// ====================================================================

// First run only. Password: ADMIN_PASSWORD if set, otherwise the well-known default "admin123",
// in which case the account is flagged so the UI nags until it is changed.
async function ensureInitialAdmin() {
  if (store.userCount() > 0) return null;

  const username = v.username(process.env.ADMIN_USERNAME || 'admin');
  const custom = process.env.ADMIN_PASSWORD;
  if (custom) v.password(custom, 'ADMIN_PASSWORD');
  const password = custom || DEFAULT_ADMIN_PASSWORD;

  store.createUser({
    username,
    password_hash: await auth.hashPassword(password),
    role: 'superuser',
    must_change: !custom,
  });
  return { username, password, isDefault: !custom };
}

function runAutoHold() {
  try {
    const held = store.autoHoldStale();
    if (held > 0) {
      realtime.broadcastData();
      if (!config.QUIET) console.log(`${new Date().toISOString()} auto-hold: moved ${held} stale alert(s) to ${AUTO_STATUS}`);
    }
  } catch (err) {
    console.error('auto-hold failed:', err);
  }
}

async function start() {
  const created = await ensureInitialAdmin();
  if (created) {
    const bar = '='.repeat(62);
    console.log(`\n${bar}\n First run: created the initial super user account\n   username: ${created.username}`);
    if (created.isDefault) {
      console.log(`   password: ${created.password}   <- default, change it right after signing in`);
    } else {
      console.log('   password: (taken from the ADMIN_PASSWORD environment variable)');
    }
    console.log(`${bar}\n`);
  }

  const server = createServer();
  server.listen(config.PORT, config.HOST, () => {
    console.log(`SRE dashboard listening on http://${config.HOST}:${server.address().port}`);
  });

  // Housekeeping: expired sessions hourly, stale alerts -> On Hold every 10 minutes (and once now).
  const purge = setInterval(() => { auth.purgeExpiredSessions(); store.purgeOldNotifications(); }, 3600 * 1000);
  const hold = setInterval(runAutoHold, 10 * 60 * 1000);
  purge.unref();
  hold.unref();
  runAutoHold();

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    realtime.closeAll(); // open live streams would otherwise keep the server from closing
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { createServer, ensureInitialAdmin };
