// The notification bell (top right): alerts created with "Assigned with take care" notify everyone else.

import { api, session } from './api.js';
import { html } from './util.js';
import { toast } from './ui.js';
import { timeAgo } from './util.js';

const state = { items: [], unread: 0, seen: new Set(), primed: false, open: false };

export function resetNotifications() {
  state.items = [];
  state.unread = 0;
  state.seen = new Set();
  state.primed = false;
  state.open = false;
}

export const bellHtml = () => html`
  <div class="notif" id="notif">
    <button type="button" class="notif__btn" id="notifBtn" data-top="bell" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22Zm6.5-6.2V11a6.5 6.5 0 0 0-5-6.3V4a1.5 1.5 0 0 0-3 0v.7a6.5 6.5 0 0 0-5 6.3v4.8L4 17.3V18h16v-.7l-1.5-1.5Z"/></svg>
      <span class="notif__badge" id="notifBadge" hidden></span>
    </button>
    <div class="notif__panel" id="notifPanel" role="region" aria-label="Notifications" hidden></div>
  </div>`;

// Fill in the badge and the list. Safe to call whenever the top bar has just been redrawn.
export function renderNotifications() {
  const badge = document.getElementById('notifBadge');
  const panel = document.getElementById('notifPanel');
  const btn = document.getElementById('notifBtn');
  if (!badge || !panel || !btn) return;

  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
  btn.setAttribute('aria-label', state.unread ? `Notifications, ${state.unread} unread` : 'Notifications');
  btn.setAttribute('aria-expanded', String(state.open));
  panel.hidden = !state.open;

  panel.innerHTML = html`
    <div class="notif__head">
      <span>Notifications</span>
      ${state.unread ? html`<button type="button" class="link-btn" data-top="notif-all">Mark all as read</button>` : ''}
    </div>
    ${state.items.length === 0
      ? html`<p class="notif__empty">Nothing yet. You are told here when someone creates an alert that anyone can take care of.</p>`
      : state.items.map((n) => html`
        <button type="button" class="notif__item ${n.read ? '' : 'is-unread'}" data-notif="${n.id}" data-incident="${n.incident_id ?? ''}">
          ${n.text}
          <span class="notif__time">${timeAgo(n.created_at)}</span>
        </button>`)}`.text;
}

// announce = true when a live ping told us something new arrived: show a toast for it.
export async function loadNotifications({ announce = false } = {}) {
  if (!session.user) return;
  const data = await api('/api/notifications');
  const fresh = data.items.filter((n) => !n.read && !state.seen.has(n.id));
  data.items.forEach((n) => state.seen.add(n.id));
  state.items = data.items;
  state.unread = data.unread;
  renderNotifications();
  if (announce && state.primed && fresh.length) {
    toast(fresh.length === 1 ? fresh[0].text : `${fresh.length} new alerts need someone to take care of them`, 'info');
  }
  state.primed = true;
}

export function togglePanel(force) {
  state.open = typeof force === 'boolean' ? force : !state.open;
  renderNotifications();
}

export const isPanelOpen = () => state.open;

export async function markRead(ids) {
  for (const n of state.items) if (ids.includes(n.id)) n.read = true;
  state.unread = state.items.filter((n) => !n.read).length;
  renderNotifications();
  try {
    const res = await api('/api/notifications/read', { method: 'POST', body: { ids } });
    state.unread = res.unread;
    renderNotifications();
  } catch { /* the next refresh corrects the count */ }
}

export async function markAllRead() {
  state.items.forEach((n) => { n.read = true; });
  state.unread = 0;
  renderNotifications();
  try { await api('/api/notifications/read', { method: 'POST', body: { all: true } }); } catch { /* corrected on next load */ }
}
