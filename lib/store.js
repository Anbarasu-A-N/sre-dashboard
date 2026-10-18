'use strict';

const crypto = require('crypto');
const { db, tx } = require('./db');
const { DONE_STATUS, AUTO_STATUS, RESUME_STATUS, AUTO_HOLD_DAYS, SEVERITY_VALUES, MODE_LABEL } = require('./config');

const now = () => new Date().toISOString();

function parseLinks(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const LIST_COLS = 'id, title, description, severity, status, mode, created_by, assignee, created_at, updated_at, closed_at, last_update_at, hold_auto, single_holder';
const DETAIL_COLS = `${LIST_COLS}, links`;

const withLinks = (row) => (row ? { ...row, links: parseLinks(row.links) } : null);

// ====================================================================
// Incidents
// ====================================================================

// `mine` (a username) limits the list to alerts that person is ASSIGNED to or is TAKING CARE of,
// and tags each row with mine_kind: 'assigned' | 'care' (assigned wins if both).
function listIncidents({ status, severity, assignee, created_by, active, q, mine } = {}) {
  const where = [];
  const params = [];
  const selectParams = [];
  let cols = LIST_COLS;

  if (mine) {
    const me = mine.toLowerCase();
    cols += ", CASE WHEN LOWER(assignee) = ? THEN 'assigned' ELSE 'care' END AS mine_kind";
    selectParams.push(me);
    where.push("(LOWER(assignee) = ? OR (mode = 'takecare' AND id IN (SELECT incident_id FROM carers WHERE username = ?)))");
    params.push(me, me);
  }
  if (status) { where.push('status = ?'); params.push(status); }
  if (severity) { where.push('severity = ?'); params.push(severity); }
  if (assignee === '__none__') {
    where.push("assignee = ''");
  } else if (assignee) {
    where.push('LOWER(assignee) = ?');
    params.push(assignee.toLowerCase());
  }
  if (created_by) { where.push('LOWER(created_by) = ?'); params.push(created_by.toLowerCase()); }
  if (active) { where.push('status != ?'); params.push(DONE_STATUS); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }

  const sql = `SELECT ${cols} FROM incidents
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (status = ?) ASC, updated_at DESC LIMIT 1000`;
  return db.prepare(sql).all(...selectParams, ...params, DONE_STATUS);
}

function getIncidentRow(id) {
  return withLinks(db.prepare(`SELECT ${DETAIL_COLS} FROM incidents WHERE id = ?`).get(id));
}

// ---------- Timeline activity (automatic comments between the events) ----------

function logActivity(incidentId, kind, actor, text, at = now()) {
  db.prepare('INSERT INTO activity (incident_id, kind, actor, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(incidentId, kind, actor, text, at);
}

function getActivity(incidentId) {
  return db.prepare('SELECT id, kind, actor, text, created_at FROM activity WHERE incident_id = ? ORDER BY created_at ASC, id ASC')
    .all(incidentId);
}

function getIncident(id) {
  const incident = getIncidentRow(id);
  if (!incident) return null;
  // Events are always chronological by the time the user says they happened.
  const events = db.prepare('SELECT * FROM events WHERE incident_id = ? ORDER BY event_time ASC, id ASC').all(id)
    .map(withLinks);
  return { ...incident, events, activity: getActivity(id), carers: getCarers(id) };
}

// ---------- Take care: people who may ADD timeline events without being assigned ----------

function getCarers(incidentId) {
  return db.prepare('SELECT username FROM carers WHERE incident_id = ? ORDER BY created_at ASC, username ASC')
    .all(incidentId).map((r) => r.username);
}

function addCarer(incidentId, username, actor) {
  tx(() => {
    const ts = now();
    const info = db.prepare('INSERT OR IGNORE INTO carers (incident_id, username, created_at) VALUES (?, ?, ?)')
      .run(incidentId, username.toLowerCase(), ts);
    if (info.changes > 0) {
      db.prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(ts, incidentId);
      logActivity(incidentId, 'took_care', actor, `${actor} took care of this alert`, ts);
    }
  });
  return getIncident(incidentId);
}

function removeCarer(incidentId, username, actor) {
  tx(() => {
    const ts = now();
    const info = db.prepare('DELETE FROM carers WHERE incident_id = ? AND username = ?').run(incidentId, username.toLowerCase());
    if (info.changes > 0) {
      db.prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(ts, incidentId);
      logActivity(incidentId, 'left_care', actor,
        actor.toLowerCase() === username.toLowerCase() ? `${actor} stopped taking care of this alert` : `${actor} released ${username} from taking care of this alert`, ts);
    }
  });
  return getIncident(incidentId);
}

// ---------- Notifications ----------

// A new "Assigned with take care" alert tells everyone else, so someone can take care of it.
// Returns the ids of the users who were notified (the caller pushes a live ping to them).
function notifyNewTakecareAlert(incident, creator) {
  const people = db.prepare('SELECT id, username FROM users WHERE id != ?').all(creator.id);
  const ts = now();
  const insert = db.prepare('INSERT INTO notifications (user_id, incident_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)');
  tx(() => {
    for (const person of people) {
      const forAssignee = incident.assignee && incident.assignee.toLowerCase() === person.username.toLowerCase();
      let text;
      if (forAssignee) text = `${creator.username} created "${incident.title}" (${incident.severity}) and assigned it to you`;
      else if (incident.single_holder) text = `${creator.username} created "${incident.title}" (${incident.severity}). Nobody is assigned yet: assign it to yourself or take care of it.`;
      else text = `${creator.username} created "${incident.title}" (${incident.severity}). Anyone can take care of it.`;
      insert.run(person.id, incident.id, 'takecare_alert', text, ts);
    }
  });
  return people.map((p) => p.id);
}

function listNotifications(userId, limit = 30) {
  const rows = db.prepare('SELECT id, incident_id, kind, text, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).c;
  return {
    unread,
    items: rows.map((r) => ({ id: r.id, incident_id: r.incident_id, kind: r.kind, text: r.text, created_at: r.created_at, read: !!r.read_at })),
  };
}

function markNotificationsRead(userId, { ids, all }) {
  const ts = now();
  if (all) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(ts, userId);
  } else {
    const mark = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
    for (const id of ids) mark.run(ts, userId, id);
  }
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).c;
}

function purgeOldNotifications(days = 30) {
  return db.prepare('DELETE FROM notifications WHERE created_at < ?')
    .run(new Date(Date.now() - days * 86400000).toISOString()).changes;
}

function createIncident(user, { title, description, severity, mode, assignee, links }) {
  // Take-care alerts created with nobody assigned are open for pickup: anyone may assign themselves.
  // (The column keeps its original name, single_holder, so existing databases and backups stay valid.)
  const singleHolder = mode === 'takecare' && !assignee ? 1 : 0;
  return tx(() => {
    const ts = now();
    const info = db.prepare(`
      INSERT INTO incidents (uid, title, description, severity, status, mode, created_by, assignee, links, created_at, updated_at, last_update_at, single_holder)
      VALUES (?, ?, ?, ?, 'Ongoing', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), title, description, severity, mode, user.username, assignee, JSON.stringify(links), ts, ts, ts, singleHolder);
    const id = Number(info.lastInsertRowid);

    let text = `${user.username} created this alert`;
    if (!assignee) text += ' (unassigned)';
    else if (assignee.toLowerCase() === user.username.toLowerCase()) text += ' and is taking care of it';
    else text += `, assigned to ${assignee}`;
    logActivity(id, 'created', user.username, text, ts);
    return getIncident(id);
  });
}

function updateIncident(id, patch, user) {
  const existing = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!existing) return null;
  const actor = user ? user.username : 'system';

  const sets = [];
  const params = [];
  for (const key of ['title', 'description', 'severity', 'status', 'mode']) {
    if (patch[key] !== undefined) { sets.push(`${key} = ?`); params.push(patch[key]); }
  }
  if (patch.links !== undefined) { sets.push('links = ?'); params.push(JSON.stringify(patch.links)); }
  if (sets.length === 0) return getIncident(id);

  const ts = now();
  sets.push('updated_at = ?');
  params.push(ts);

  const statusChanged = patch.status !== undefined && patch.status !== existing.status;
  if (statusChanged) {
    // A manual status change restarts the "no update for N days" clock.
    sets.push('last_update_at = ?');
    params.push(ts);
    sets.push('hold_auto = 0'); // whatever the status is now, a person chose it
    if (patch.status === DONE_STATUS) { sets.push('closed_at = ?'); params.push(ts); }
    else sets.push('closed_at = NULL');
  }

  const modeChanged = patch.mode !== undefined && patch.mode !== existing.mode;
  // Private = only the creator works on it, so ownership returns to them.
  const reassignedToCreator = modeChanged && patch.mode === 'private' && existing.assignee !== existing.created_by;
  if (reassignedToCreator) { sets.push('assignee = ?'); params.push(existing.created_by); }

  tx(() => {
    db.prepare(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    if (statusChanged) logActivity(id, 'status', actor, `${actor} changed the status from ${existing.status} to ${patch.status}`, ts);
    if (modeChanged) {
      let text = `${actor} changed who can continue this alert to "${MODE_LABEL[patch.mode]}"`;
      if (reassignedToCreator) text += `; it is now assigned back to ${existing.created_by}`;
      logActivity(id, 'mode', actor, text, ts);
    }
  });
  return getIncident(id);
}

// activity: { kind, actor, text } is recorded in the same transaction as the change.
function assignIncident(id, assignee, activity) {
  tx(() => {
    const ts = now();
    db.prepare('UPDATE incidents SET assignee = ?, updated_at = ? WHERE id = ?').run(assignee, ts, id);
    if (activity) logActivity(id, activity.kind, activity.actor, activity.text, ts);

    // The assignee works on the alert fully, so they are no longer listed as "taking care".
    // Everybody else who is taking care keeps doing so.
    if (assignee) db.prepare('DELETE FROM carers WHERE incident_id = ? AND username = ?').run(id, assignee.toLowerCase());
  });
  return getIncident(id);
}

function deleteIncident(id) {
  return db.prepare('DELETE FROM incidents WHERE id = ?').run(id).changes > 0;
}

// An Ongoing alert with no timeline update for N days goes On Hold automatically.
// Only Ongoing is affected: Monitoring is set and cleared by people, never by the system.
function autoHoldStale({ now: nowMs = Date.now(), days = AUTO_HOLD_DAYS } = {}) {
  const cutoff = new Date(nowMs - days * 86400000).toISOString();
  const stale = db.prepare("SELECT id FROM incidents WHERE status = 'Ongoing' AND last_update_at < ?").all(cutoff);
  if (stale.length === 0) return 0;

  const at = new Date(nowMs).toISOString();
  tx(() => {
    for (const { id } of stale) {
      db.prepare('UPDATE incidents SET status = ?, hold_auto = 1, updated_at = ? WHERE id = ?').run(AUTO_STATUS, at, id);
      logActivity(id, 'auto_hold', 'system', `Automatically moved to ${AUTO_STATUS}: no timeline update for ${days} days`, at);
    }
  });
  return stale.length;
}

// ====================================================================
// Timeline events
// ====================================================================

const touchIncident = (incidentId) =>
  db.prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(now(), incidentId);

// Adding or editing a timeline event is an "update": it restarts the idle clock,
// and brings an AUTOMATICALLY held alert back to Ongoing.
function registerUpdate(incidentId, actor) {
  const ts = now();
  const incident = db.prepare('SELECT status, hold_auto FROM incidents WHERE id = ?').get(incidentId);
  // A hold someone set by hand stays until they lift it; only an automatic hold resumes on activity.
  if (incident && incident.status === AUTO_STATUS && incident.hold_auto === 1) {
    db.prepare('UPDATE incidents SET status = ?, hold_auto = 0, last_update_at = ?, updated_at = ? WHERE id = ?').run(RESUME_STATUS, ts, ts, incidentId);
    logActivity(incidentId, 'resumed', actor, `${actor} added an update, so the alert is back to ${RESUME_STATUS}`, ts);
  } else {
    db.prepare('UPDATE incidents SET last_update_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, incidentId);
  }
}

function getEvent(id) {
  return withLinks(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
}

function addEvent(incidentId, user, { label, event_time, note, links }) {
  return tx(() => {
    // sort_order is no longer used for display (the timeline is chronological) but the column stays.
    const row = db.prepare('SELECT MAX(sort_order) AS maxOrder FROM events WHERE incident_id = ?').get(incidentId);
    const nextOrder = (row && row.maxOrder !== null ? row.maxOrder : -1) + 1;
    const info = db.prepare(`
      INSERT INTO events (incident_id, label, event_time, note, links, created_by, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(incidentId, label, event_time, note, JSON.stringify(links), user.username, nextOrder, now());
    registerUpdate(incidentId, user.username);
    return getEvent(Number(info.lastInsertRowid));
  });
}

function updateEvent(id, patch, user) {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!existing) return null;

  const sets = [];
  const params = [];
  for (const key of ['label', 'event_time', 'note']) {
    if (patch[key] !== undefined) { sets.push(`${key} = ?`); params.push(patch[key]); }
  }
  if (patch.links !== undefined) { sets.push('links = ?'); params.push(JSON.stringify(patch.links)); }
  if (sets.length === 0) return getEvent(id);

  tx(() => {
    db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    registerUpdate(existing.incident_id, user ? user.username : 'system');
  });
  return getEvent(id);
}

function deleteEvent(id) {
  const existing = db.prepare('SELECT incident_id FROM events WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  touchIncident(existing.incident_id);
  return true;
}

// ====================================================================
// Users
// ====================================================================

const USER_COLS = 'id, username, role, created_at, must_change_password';

const userCount = () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const countSuperusers = () => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'superuser'").get().c;
const getUserByUsername = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
const listUsers = () => db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY username`).all();
const userDirectory = () => db.prepare('SELECT username, role FROM users ORDER BY username').all();

function createUser({ username, password_hash, role, must_change = false }) {
  const info = db.prepare('INSERT INTO users (username, password_hash, role, created_at, must_change_password) VALUES (?, ?, ?, ?, ?)')
    .run(username, password_hash, role, now(), must_change ? 1 : 0);
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(Number(info.lastInsertRowid));
}

function setUserRole(id, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id);
}

// mustChange = true marks a temporary/default password the person should replace.
function setUserPasswordHash(id, hash, mustChange = false) {
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(hash, mustChange ? 1 : 0, id);
}

const deleteUser = (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;

// ====================================================================
// Dashboard analytics
// ====================================================================

const DAY_MS = 86400000;

// `offsetMin` is the browser's Date.getTimezoneOffset() so "per day" means the
// viewer's local day, not UTC.
function buildTimeline(days, offsetMin) {
  const localNow = new Date(Date.now() - offsetMin * 60000);
  const todayLocalMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());

  const labels = [];
  for (let i = days - 1; i >= 0; i--) labels.push(new Date(todayLocalMidnight - i * DAY_MS).toISOString().slice(0, 10));
  const index = new Map(labels.map((l, i) => [l, i]));
  const startIso = new Date(todayLocalMidnight - (days - 1) * DAY_MS + offsetMin * 60000).toISOString();

  const keyOf = (iso) => new Date(Date.parse(iso) - offsetMin * 60000).toISOString().slice(0, 10);
  const created = new Array(days).fill(0);
  const completed = new Array(days).fill(0);

  for (const r of db.prepare('SELECT created_at FROM incidents WHERE created_at >= ?').all(startIso)) {
    const i = index.get(keyOf(r.created_at));
    if (i !== undefined) created[i] += 1;
  }
  for (const r of db.prepare('SELECT closed_at FROM incidents WHERE closed_at IS NOT NULL AND closed_at >= ?').all(startIso)) {
    const i = index.get(keyOf(r.closed_at));
    if (i !== undefined) completed[i] += 1;
  }
  return { days, labels, created, completed };
}

function dashboardData({ days, offsetMin }) {
  const byStatus = {};
  let total = 0;
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM incidents GROUP BY status').all()) {
    byStatus[r.status] = r.c;
    total += r.c;
  }

  const sevRows = db.prepare('SELECT severity, status, COUNT(*) AS c FROM incidents GROUP BY severity, status').all();
  const activeAlerts = db.prepare(`
    SELECT id, title, status, assignee, mode FROM incidents
    WHERE severity = ? AND status != ? ORDER BY updated_at DESC LIMIT 5
  `);
  const severity = SEVERITY_VALUES.map((sev) => {
    const counts = {};
    let sevTotal = 0;
    for (const r of sevRows) if (r.severity === sev) { counts[r.status] = r.c; sevTotal += r.c; }
    return {
      severity: sev,
      total: sevTotal,
      active: sevTotal - (counts[DONE_STATUS] || 0),
      byStatus: counts,
      alerts: activeAlerts.all(sev, DONE_STATUS),
    };
  });

  const people = new Map();
  const slot = (name) => {
    if (!people.has(name)) people.set(name, { user: name, created: 0, working: 0 });
    return people.get(name);
  };
  for (const r of db.prepare('SELECT LOWER(created_by) AS u, COUNT(*) AS c FROM incidents GROUP BY LOWER(created_by)').all()) {
    slot(r.u).created = r.c;
  }
  for (const r of db.prepare("SELECT LOWER(assignee) AS u, COUNT(*) AS c FROM incidents WHERE assignee != '' AND status != ? GROUP BY LOWER(assignee)").all(DONE_STATUS)) {
    slot(r.u).working = r.c;
  }
  const ranked = [...people.values()].sort((a, b) => b.working - a.working || b.created - a.created || a.user.localeCompare(b.user));
  const TOP = 10;

  const unassignedActive = db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE assignee = '' AND status != ?").get(DONE_STATUS).c;

  return {
    total,
    byStatus,
    unassignedActive,
    severity,
    timeline: buildTimeline(days, offsetMin),
    users: ranked.slice(0, TOP),
    usersTruncated: Math.max(0, ranked.length - TOP),
  };
}

module.exports = {
  parseLinks,
  listIncidents, getIncident, createIncident, updateIncident, assignIncident, deleteIncident, autoHoldStale,
  logActivity, getActivity, getCarers, addCarer, removeCarer,
  notifyNewTakecareAlert, listNotifications, markNotificationsRead, purgeOldNotifications,
  getEvent, addEvent, updateEvent, deleteEvent,
  userCount, countSuperusers, getUserByUsername, getUserById, listUsers, userDirectory,
  createUser, setUserRole, setUserPasswordHash, deleteUser,
  dashboardData,
};
