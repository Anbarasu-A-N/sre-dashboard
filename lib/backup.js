'use strict';

const crypto = require('crypto');
const { db, tx } = require('./db');
const v = require('./validation');
const { isValidHash } = require('./auth');
const { HttpError, bad } = require('./errors');
const { LIMITS, MODES, ROLES, STATUS_VALUES, SEVERITY_VALUES, DONE_STATUS, LEGACY_SEVERITY, LEGACY_MODE, META } = require('./config');
const { parseLinks } = require('./store');

const APP_ID = 'sre-incident-dashboard';
const FORMAT_VERSION = 1; // fields added later are optional, so v1 files stay importable
const SCOPES = ['events', 'users', 'all'];

// ====================================================================
// Export
// ====================================================================

function exportIncidents() {
  const incidents = db.prepare('SELECT * FROM incidents ORDER BY id').all();
  const events = db.prepare('SELECT * FROM events ORDER BY incident_id, event_time, id').all();
  const activity = db.prepare('SELECT incident_id, kind, actor, text, created_at FROM activity ORDER BY incident_id, created_at, id').all();
  const carersByIncident = new Map();
  for (const c of db.prepare('SELECT incident_id, username FROM carers ORDER BY incident_id, created_at, username').all()) {
    if (!carersByIncident.has(c.incident_id)) carersByIncident.set(c.incident_id, []);
    carersByIncident.get(c.incident_id).push(c.username);
  }
  const activityByIncident = new Map();
  for (const a of activity) {
    if (!activityByIncident.has(a.incident_id)) activityByIncident.set(a.incident_id, []);
    activityByIncident.get(a.incident_id).push({ kind: a.kind, actor: a.actor, text: a.text, created_at: a.created_at });
  }

  const byIncident = new Map();
  for (const e of events) {
    if (!byIncident.has(e.incident_id)) byIncident.set(e.incident_id, []);
    byIncident.get(e.incident_id).push({
      label: e.label,
      event_time: e.event_time,
      note: e.note || '',
      created_by: e.created_by,
      created_at: e.created_at,
      links: parseLinks(e.links),
    });
  }

  return incidents.map((i) => ({
    id: i.id,
    uid: i.uid,
    title: i.title,
    description: i.description || '',
    severity: i.severity,
    status: i.status,
    mode: i.mode,
    created_by: i.created_by,
    assignee: i.assignee || '',
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    last_update_at: i.last_update_at,
    hold_auto: i.hold_auto,
    single_holder: i.single_holder,
    carers: carersByIncident.get(i.id) || [],
    links: parseLinks(i.links),
    events: byIncident.get(i.id) || [],
    activity: activityByIncident.get(i.id) || [],
  }));
}

function exportUsers() {
  // Password hashes are included so a restore keeps everyone's login working.
  return db.prepare('SELECT username, role, password_hash, created_at FROM users ORDER BY username').all();
}

function exportData(scope) {
  if (!SCOPES.includes(scope)) throw bad(`scope must be one of: ${SCOPES.join(', ')}`);
  const out = {
    app: APP_ID,
    format_version: FORMAT_VERSION,
    scope,
    exported_at: new Date().toISOString(),
  };
  if (scope === 'events' || scope === 'all') out.incidents = exportIncidents();
  if (scope === 'users' || scope === 'all') out.users = exportUsers();
  return out;
}

// ====================================================================
// Import: validate everything first, then apply in one transaction
// ====================================================================

function at(path, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw bad(`${path}: ${err.message}`);
    throw err;
  }
}

function cleanEvent(raw, fallbackCreatedAt) {
  if (!raw || typeof raw !== 'object') throw bad('is not an object');
  return {
    label: v.str(raw.label, 'label', { required: true, max: LIMITS.label }),
    event_time: v.isoDate(raw.event_time, 'event_time'),
    note: v.str(raw.note, 'note', { max: LIMITS.note }),
    created_by: v.str(raw.created_by, 'created_by', { required: true, max: 64 }),
    created_at: raw.created_at ? v.isoDate(raw.created_at, 'created_at') : fallbackCreatedAt,
    links: raw.links === undefined ? [] : v.links(raw.links),
    _order: Number.isFinite(raw.sort_order) ? raw.sort_order : 0, // only a tie-breaker for equal times
  };
}

function cleanActivity(raw, fallbackCreatedAt) {
  if (!raw || typeof raw !== 'object') throw bad('is not an object');
  return {
    kind: v.str(raw.kind, 'kind', { required: true, max: 30 }),
    actor: v.str(raw.actor, 'actor', { required: true, max: 64 }),
    text: v.str(raw.text, 'text', { required: true, max: 500 }),
    created_at: raw.created_at ? v.isoDate(raw.created_at, 'created_at') : fallbackCreatedAt,
  };
}

function cleanIncident(raw) {
  if (!raw || typeof raw !== 'object') throw bad('is not an object');
  const nowIso = new Date().toISOString();

  const createdAt = raw.created_at ? v.isoDate(raw.created_at, 'created_at') : nowIso;
  const status = v.oneOf(raw.status, STATUS_VALUES, 'status');
  // Files from older versions: "open" mode and SEV1-4 names are translated.
  const mode = raw.mode === undefined ? META.defaultMode : v.oneOf(LEGACY_MODE[raw.mode] || raw.mode, MODES, 'mode');
  const severity = v.oneOf(LEGACY_SEVERITY[raw.severity] || raw.severity, SEVERITY_VALUES, 'severity');
  const createdBy = v.str(raw.created_by, 'created_by', { required: true, max: 64 });
  const updatedAt = raw.updated_at ? v.isoDate(raw.updated_at, 'updated_at') : createdAt;
  let closedAt = v.optionalIsoDate(raw.closed_at, 'closed_at');
  if (status === DONE_STATUS && !closedAt) closedAt = updatedAt;
  if (status !== DONE_STATUS) closedAt = null;

  if (raw.events !== undefined && !Array.isArray(raw.events)) throw bad('events must be a list');
  const events = (raw.events || []).map((e, i) => at(`events[${i + 1}]`, () => cleanEvent(e, createdAt)));
  events.sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time) || a._order - b._order); // chronological

  if (raw.activity !== undefined && !Array.isArray(raw.activity)) throw bad('activity must be a list');
  const activity = (raw.activity || []).map((a, i) => at(`activity[${i + 1}]`, () => cleanActivity(a, createdAt)));

  if (raw.carers !== undefined && !Array.isArray(raw.carers)) throw bad('carers must be a list of usernames');
  const carers = [...new Set((raw.carers || []).map((c) => v.str(c, 'carer', { required: true, max: 64 }).toLowerCase()))];
  // Files from before manual holds existed: every On Hold was automatic.
  const holdAuto = raw.hold_auto === undefined ? (status === 'On Hold' ? 1 : 0) : (raw.hold_auto ? 1 : 0);

  return {
    id: raw.id === undefined || raw.id === null ? null : v.id(raw.id, 'id'),
    uid: raw.uid ? v.str(raw.uid, 'uid', { max: 64 }) : crypto.randomUUID(),
    title: v.str(raw.title, 'title', { required: true, max: LIMITS.title }),
    description: v.str(raw.description, 'description', { max: LIMITS.description }),
    severity,
    status,
    mode,
    created_by: createdBy,
    assignee: mode === 'private' ? createdBy : v.str(raw.assignee, 'assignee', { max: 64 }),
    created_at: createdAt,
    updated_at: updatedAt,
    closed_at: closedAt,
    last_update_at: raw.last_update_at ? v.isoDate(raw.last_update_at, 'last_update_at') : nowIso, // old files: fresh grace period
    links: raw.links === undefined ? [] : v.links(raw.links),
    hold_auto: status === 'On Hold' ? holdAuto : 0,
    single_holder: raw.single_holder ? 1 : 0, // older files: every alert allowed several people taking care
    carers,
    events,
    activity,
  };
}

function cleanUser(raw) {
  if (!raw || typeof raw !== 'object') throw bad('is not an object');
  if (!isValidHash(raw.password_hash)) throw bad('password_hash is missing or malformed');
  return {
    username: v.username(raw.username),
    role: v.oneOf(raw.role, ROLES, 'role'),
    password_hash: raw.password_hash,
    created_at: raw.created_at ? v.isoDate(raw.created_at, 'created_at') : new Date().toISOString(),
  };
}

function validatePayload(payload, mode) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bad('Backup file is not valid JSON object data');
  if (payload.app !== APP_ID) throw bad('This file was not exported from this dashboard');
  if (payload.format_version !== FORMAT_VERSION) throw bad(`Unsupported backup format version: ${payload.format_version}`);
  if (mode !== 'merge' && mode !== 'replace') throw bad('mode must be "merge" or "replace"');

  const hasIncidents = Array.isArray(payload.incidents);
  const hasUsers = Array.isArray(payload.users);
  if (!hasIncidents && !hasUsers) throw bad('The file contains no alerts or users to import');

  const clean = {};

  if (hasIncidents) {
    clean.incidents = payload.incidents.map((raw, i) => at(`incidents[${i + 1}]`, () => cleanIncident(raw)));
    if (mode === 'replace') {
      const ids = new Set();
      const uids = new Set();
      for (const inc of clean.incidents) {
        if (inc.id !== null) {
          if (ids.has(inc.id)) throw bad(`Duplicate alert id ${inc.id} in file`);
          ids.add(inc.id);
        }
        if (uids.has(inc.uid)) throw bad(`Duplicate alert uid ${inc.uid} in file`);
        uids.add(inc.uid);
      }
    }
  }

  if (hasUsers) {
    clean.users = payload.users.map((raw, i) => at(`users[${i + 1}]`, () => cleanUser(raw)));
    if (mode === 'replace') {
      const names = new Set();
      for (const u of clean.users) {
        if (names.has(u.username)) throw bad(`Duplicate username "${u.username}" in file`);
        names.add(u.username);
      }
      if (!clean.users.some((u) => u.role === 'superuser')) {
        throw bad('Replacing users requires at least one super user in the file (otherwise nobody could manage the dashboard)');
      }
    }
  }
  return clean;
}

function insertIncident(inc, keepId) {
  const cols = ['uid', 'title', 'description', 'severity', 'status', 'mode', 'created_by', 'assignee', 'links', 'created_at', 'updated_at', 'closed_at', 'last_update_at', 'hold_auto', 'single_holder'];
  const vals = [inc.uid, inc.title, inc.description, inc.severity, inc.status, inc.mode, inc.created_by, inc.assignee, JSON.stringify(inc.links), inc.created_at, inc.updated_at, inc.closed_at, inc.last_update_at, inc.hold_auto, inc.single_holder];
  if (keepId && inc.id !== null) { cols.unshift('id'); vals.unshift(inc.id); }

  const info = db.prepare(`INSERT INTO incidents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  const incidentId = Number(info.lastInsertRowid);

  const insertEvent = db.prepare(`
    INSERT INTO events (incident_id, label, event_time, note, links, created_by, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  inc.events.forEach((e, i) => {
    insertEvent.run(incidentId, e.label, e.event_time, e.note, JSON.stringify(e.links), e.created_by, i, e.created_at);
  });

  const insertActivity = db.prepare('INSERT INTO activity (incident_id, kind, actor, text, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const a of inc.activity) insertActivity.run(incidentId, a.kind, a.actor, a.text, a.created_at);

  const insertCarer = db.prepare('INSERT OR IGNORE INTO carers (incident_id, username, created_at) VALUES (?, ?, ?)');
  for (const name of inc.carers) insertCarer.run(incidentId, name, inc.created_at);
}

function importData(payload, mode) {
  const clean = validatePayload(payload, mode);

  return tx(() => {
    const summary = {};

    if (clean.users) {
      if (mode === 'replace') db.exec('DELETE FROM users'); // sessions cascade: everyone must sign in again
      let imported = 0;
      let skipped = 0;
      const exists = db.prepare('SELECT 1 FROM users WHERE username = ?');
      const insert = db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)');
      for (const u of clean.users) {
        if (exists.get(u.username)) { skipped++; continue; }
        insert.run(u.username, u.password_hash, u.role, u.created_at);
        imported++;
      }
      summary.users = { imported, skipped };
    }

    if (clean.incidents) {
      if (mode === 'replace') db.exec('DELETE FROM incidents'); // events cascade
      let imported = 0;
      let skipped = 0;
      const exists = db.prepare('SELECT 1 FROM incidents WHERE uid = ?');
      for (const inc of clean.incidents) {
        if (exists.get(inc.uid)) { skipped++; continue; }
        insertIncident(inc, mode === 'replace');
        imported++;
      }
      summary.incidents = { imported, skipped };
    }
    return summary;
  });
}

module.exports = { exportData, importData, SCOPES };
