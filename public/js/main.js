import { api, session, loadSession, setSessionLostHandler, isSignedIn, isSuperUser } from './api.js';
import { html } from './util.js';
import { toast, formDialog, hasOpenDialog } from './ui.js';
import { startRealtime, restartRealtime } from './realtime.js';
import {
  bellHtml, renderNotifications, loadNotifications, resetNotifications,
  togglePanel, isPanelOpen, markRead, markAllRead,
} from './notifications.js';
import * as dashboard from './views/dashboard.js';
import * as alerts from './views/alerts.js';
import * as incident from './views/incident.js';
import * as users from './views/users.js';
import * as backup from './views/backup.js';

const VIEWS = { dashboard, alerts, incident, users, backup };
const TITLES = { dashboard: 'Dashboard', alerts: 'Alerts', incident: 'Alert', users: 'Users', backup: 'Backup & export' };

const mount = document.getElementById('view');
const topbarActions = document.getElementById('topbarActions');
const banner = document.getElementById('banner');
const pwBanner = document.getElementById('pwBanner');

let meta = null;
let renderToken = 0;
let current = {};
let lastHash = null;
let prevHash = '';
let lastRefresh = Date.now();

// ---------------------------------------------------------------------
// Routing  (#  | #alerts?status=..&severity=..  | #incident/12 | #users | #backup)
// ---------------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));

  const inc = path.match(/^incident\/(\d+)$/);
  if (inc) return { name: 'incident', params: { id: inc[1] }, query };

  const legacy = path.match(/^status\/(.+)$/); // old bookmarks: #status/Ongoing
  if (legacy) {
    const status = decodeURIComponent(legacy[1]);
    return { name: 'alerts', params: {}, query: status === 'all' ? {} : { status } };
  }
  if (path === 'alerts') return { name: 'alerts', params: {}, query };
  if (path === 'users') return { name: 'users', params: {}, query: {} };
  if (path === 'backup') return { name: 'backup', params: {}, query: {} };
  return { name: 'dashboard', params: {}, query: {} };
}

// Where "Back" should go from an alert: the list it was opened from, else the dashboard.
function backTarget() {
  return prevHash && !prevHash.startsWith('#incident') && prevHash !== location.hash ? prevHash : '#';
}

const gatePanel = (title, text, withSignIn) => html`
  <a class="btn btn--ghost" href="#">&larr; Dashboard</a>
  <div class="empty-state"><p><strong>${title}</strong></p><p class="empty-state__hint">${text}</p>
  ${withSignIn ? html`<button type="button" class="btn btn--primary" data-top="login">Sign in</button>` : ''}</div>`.text;

async function route() {
  const token = ++renderToken;
  const isCurrent = () => token === renderToken;
  const parsed = parseHash();

  const hashChanged = location.hash !== lastHash;
  lastHash = location.hash;

  // A fresh container per navigation means a view's listeners disappear with it.
  const container = document.createElement('div');
  mount.replaceChildren(container);
  current = {};
  document.title = `${TITLES[parsed.name]} · Incident Timeline`;
  document.querySelector('.user-menu')?.removeAttribute('open');

  if (parsed.name === 'users' && !isSuperUser()) {
    container.innerHTML = gatePanel('Super user access required', isSignedIn() ? 'Your account cannot manage users.' : 'Sign in with a super user account to manage users.', !isSignedIn());
    return;
  }
  if (parsed.name === 'backup' && !isSignedIn()) {
    container.innerHTML = gatePanel('Please sign in', 'Exporting data requires a signed-in account.', true);
    return;
  }

  try {
    const handle = await VIEWS[parsed.name].render(container, {
      isCurrent, meta, params: parsed.params, query: parsed.query, backTarget, refreshSession,
    });
    if (isCurrent()) { current = handle || {}; lastRefresh = Date.now(); }
  } catch (err) {
    if (isCurrent()) {
      container.innerHTML = html`<div class="empty-state"><p><strong>Something went wrong</strong></p><p class="empty-state__hint">${err.message}</p>
        <button type="button" class="btn btn--ghost" data-top="reload">Try again</button></div>`.text;
    }
  }
  if (isCurrent() && hashChanged) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => {
  prevHash = lastHash || '';
  route();
});

// ---------------------------------------------------------------------
// Session + top bar
// ---------------------------------------------------------------------

function renderTopbar() {
  const u = session.user;
  banner.hidden = !!u;
  pwBanner.hidden = !(u && u.mustChangePassword);

  topbarActions.innerHTML = u
    ? html`
      <button type="button" class="btn btn--primary" data-top="new">New alert</button>
      ${bellHtml()}
      <details class="user-menu">
        <summary class="user-menu__btn" aria-label="Account menu for ${u.username}">
          <span class="avatar" aria-hidden="true">${u.username.slice(0, 1).toUpperCase()}</span>
          <span class="user-menu__name">${u.username}</span>
          ${u.role === 'superuser' ? html`<span class="tag tag--accent">Super user</span>` : ''}
        </summary>
        <div class="user-menu__panel">
          <a href="#backup">Backup &amp; export</a>
          ${u.role === 'superuser' ? html`<a href="#users">Manage users</a>` : ''}
          <button type="button" data-top="password">Change password</button>
          <button type="button" data-top="logout">Sign out</button>
        </div>
      </details>`.text
    : html`<button type="button" class="btn btn--primary" data-top="login">Sign in</button>`.text;

  renderNotifications(); // fill the bell that was just drawn
}

// Who is signed in changed (sign in, sign out, session ended): the live stream and the bell follow.
function onSessionChanged() {
  resetNotifications();
  renderTopbar();
  if (session.user) loadNotifications().catch(() => {});
  restartRealtime();
}

async function refreshSession() {
  await loadSession();
  onSessionChanged();
  await route();
}

setSessionLostHandler(() => {
  toast('Your session has ended. Please sign in again.', 'error');
  onSessionChanged();
  route();
});

async function openLogin() {
  const ok = await formDialog({
    title: 'Sign in',
    submitLabel: 'Sign in',
    fields: [
      { name: 'username', label: 'Username', required: true, autocomplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' },
    ],
    onSubmit: async (v) => {
      const res = await api('/api/auth/login', { method: 'POST', body: { username: v.username, password: v.password } });
      session.user = res.user;
    },
  });
  if (ok) {
    onSessionChanged();
    toast(`Signed in as ${session.user.username}`, 'success');
    route();
    if (session.user.mustChangePassword) openChangePassword(); // dismissable; the banner stays until it is done
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
  session.user = null;
  onSessionChanged();
  if (['#users', '#backup'].includes(location.hash)) location.hash = '';
  else route();
  toast('Signed out', 'success');
}

async function openChangePassword() {
  const ok = await formDialog({
    title: 'Change password',
    submitLabel: 'Change password',
    description: 'You will stay signed in here; other devices are signed out.',
    fields: [
      { name: 'current', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'next', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 8 characters.' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    onSubmit: async (v) => {
      if (v.next !== v.confirm) throw new Error('The new passwords do not match');
      await api('/api/auth/password', { method: 'POST', body: { current_password: v.current, new_password: v.next } });
    },
  });
  if (ok) {
    if (session.user) session.user.mustChangePassword = false;
    renderTopbar();
    toast('Password changed', 'success');
  }
}

async function openNewAlert() {
  const directory = await api('/api/users/directory');
  const me = session.user.username;

  const assigneeOptions = [
    { value: me, label: `Me (${me})` },
    { value: '__none__', label: 'Nobody yet (anyone can pick it up)' },
    ...directory.filter((u) => u.username !== me).map((u) => ({ value: u.username, label: u.username })),
  ];

  const created = await formDialog({
    title: 'New alert',
    submitLabel: 'Create alert',
    fields: [
      { name: 'title', label: 'Title', required: true, maxlength: 200, placeholder: 'e.g. Arattai WMSAdmin Website Unavailable' },
      { name: 'description', label: 'Description', type: 'textarea', maxlength: 5000, placeholder: 'Short context for whoever picks this up next' },
      { name: 'severity', label: 'Severity', type: 'select', value: meta.defaultSeverity, options: meta.severities.map((s) => ({ value: s, label: s })) },
      {
        name: 'mode', label: 'Who can continue this alert?', type: 'radio', value: meta.defaultMode,
        options: meta.modes.map((m) => ({ value: m.value, label: m.value === meta.defaultMode ? `${m.label} (default)` : m.label, hint: m.hint })),
      },
      {
        name: 'assignee', label: 'Assign to', type: 'select', value: me, options: assigneeOptions, visible: (v) => v.mode !== 'private',
        hint: 'Choose "Nobody yet" and anyone signed in can pick it up: either assign it to themselves (then only they, you and super users can change the assignment or the status) or just take care of it (add events; several people can).',
      },
      { name: 'links', label: 'Links', type: 'links', hint: 'Add any number of named links (dashboards, runbooks, tickets). Each opens in a new tab.' },
    ],
    onSubmit: (v) => {
      const body = { title: v.title.trim(), description: v.description.trim(), severity: v.severity, mode: v.mode, links: v.links };
      if (v.mode !== 'private') body.assignee = v.assignee === '__none__' ? '' : v.assignee;
      return api('/api/incidents', { method: 'POST', body });
    },
  });
  if (created && created.id) {
    toast('Alert created', 'success');
    location.hash = `#incident/${created.id}`;
  }
}

document.addEventListener('click', (e) => {
  const menu = document.querySelector('.user-menu');
  if (menu && menu.open && !e.target.closest('.user-menu')) menu.removeAttribute('open');
  if (menu && e.target.closest('.user-menu__panel a, .user-menu__panel button')) menu.removeAttribute('open');

  if (isPanelOpen() && !e.target.closest('.notif')) togglePanel(false);

  const notif = e.target.closest('[data-notif]');
  if (notif) {
    const id = Number(notif.dataset.notif);
    const incidentId = notif.dataset.incident;
    markRead([id]);
    togglePanel(false);
    if (incidentId) location.hash = `#incident/${incidentId}`;
    return;
  }

  const top = e.target.closest('[data-top]');
  if (top) {
    const action = top.dataset.top;
    if (action === 'bell') { togglePanel(); if (isPanelOpen()) loadNotifications().catch(() => {}); }
    else if (action === 'notif-all') markAllRead();
    else if (action === 'login') openLogin();
    else if (action === 'logout') logout();
    else if (action === 'password') openChangePassword();
    else if (action === 'new') openNewAlert().catch((err) => toast(err.message, 'error'));
    else if (action === 'reload') route();
    return;
  }

  // Any element carrying data-href navigates (donut slices, table rows).
  const nav = e.target.closest('[data-href]');
  if (nav && !e.target.closest('a')) location.hash = nav.dataset.href;
});

// ---------------------------------------------------------------------
// Keep the dashboard fresh while people hand over between shifts
// ---------------------------------------------------------------------

let dirty = false; // a change arrived while we could not safely redraw

async function refreshCurrent() {
  if (!current.refresh) return;
  const active = document.activeElement;
  const busy = document.hidden || hasOpenDialog() || (active && active.tagName === 'SELECT' && mount.contains(active));
  if (busy) { dirty = true; return; } // do it as soon as the user is done
  dirty = false;
  try { await current.refresh(); lastRefresh = Date.now(); } catch { /* transient; the next tick retries */ }
}

// Safety net: if live updates are blocked somewhere (a proxy, an old browser), we still catch up within a minute.
setInterval(() => {
  if (dirty || Date.now() - lastRefresh > 60000) refreshCurrent();
}, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (dirty || Date.now() - lastRefresh > 5000)) refreshCurrent();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isPanelOpen()) { togglePanel(false); document.getElementById('notifBtn')?.focus(); }
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

(async function boot() {
  try {
    [meta] = await Promise.all([api('/api/meta'), loadSession()]);
  } catch (err) {
    mount.innerHTML = html`<div class="empty-state"><p><strong>The dashboard could not load</strong></p><p class="empty-state__hint">${err.message}</p></div>`.text;
    return;
  }
  renderTopbar();
  if (session.user) loadNotifications().catch(() => {});
  lastHash = location.hash;
  route();

  // Everyone's screen updates by itself when anyone changes anything; the bell updates when you are notified.
  startRealtime({
    data: () => {
      refreshCurrent();
      if (session.user) loadNotifications().catch(() => {}); // e.g. a deleted alert takes its notifications with it
    },
    notify: () => loadNotifications({ announce: true }).catch(() => {}),
  });
})();
