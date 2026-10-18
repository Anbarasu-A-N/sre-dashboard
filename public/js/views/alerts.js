import { api, isSignedIn } from '../api.js';
import { html, timeAgo, plural } from '../util.js';

export function titleFor(q) {
  const parts = [];
  if (q.status) parts.push(q.status);
  else if (q.active) parts.push('Active');
  if (q.severity) parts.push(q.severity);
  if (q.assignee === '__none__') parts.push('Unassigned');
  else if (q.assignee) parts.push(`Assigned to ${q.assignee}`);
  if (q.created_by) parts.push(`Opened by ${q.created_by}`);

  if (q.mine) return parts.length ? `My ${parts.join(' · ')} alerts` : 'My alerts';
  if (parts.length === 0) return 'All alerts';
  return `${parts.join(' · ')} alerts`;
}

// "My alerts" has exactly two categories.
export function groupMine(rows) {
  return {
    assigned: rows.filter((r) => r.mine_kind === 'assigned'),
    care: rows.filter((r) => r.mine_kind === 'care'),
  };
}

export async function render(root, ctx) {
  const { isCurrent, meta, query } = ctx;
  const statusColor = Object.fromEntries(meta.statuses.map((s) => [s.value, s.color]));
  const signedIn = isSignedIn();
  const mine = !!query.mine && signedIn; // "my alerts" only makes sense when signed in
  let search = '';

  // The same filters, with "mine" switched on or off, as a link.
  const toggleHref = () => {
    const next = new URLSearchParams();
    for (const key of ['status', 'severity', 'assignee', 'created_by', 'active']) if (query[key]) next.set(key, query[key]);
    if (!mine) next.set('mine', '1');
    const qs = next.toString();
    return `#alerts${qs ? `?${qs}` : ''}`;
  };

  const tableHtml = (rows) => html`<table class="incident-table alerts-table">
    <thead><tr>
      <th scope="col">Status</th><th scope="col">Title</th><th scope="col">Severity</th>
      <th scope="col">Assigned to</th><th scope="col">Opened by</th><th scope="col">Age</th><th scope="col">Updated</th>
    </tr></thead>
    <tbody>${rows.map((i) => html`
      <tr data-href="#incident/${i.id}">
        <td><span class="status-pill" style="--dot:${statusColor[i.status] || '#8b95a1'}">${i.status}</span></td>
        <td class="title-cell">
          <a class="row-link" href="#incident/${i.id}">${i.title}</a>
          ${i.mode === 'private' ? html` <span class="tag" title="Only the creator and super users can work on this alert">Only me</span>` : ''}
          ${i.description ? html`<span class="desc">${i.description}</span>` : ''}
        </td>
        <td data-label="Severity"><span class="sev-tag">${i.severity}</span></td>
        <td data-label="Assigned to">${i.assignee ? i.assignee : html`<span class="faint">Unassigned</span>`}</td>
        <td data-label="Opened by">${i.created_by}</td>
        <td class="mono" data-label="Age">${timeAgo(i.created_at)}</td>
        <td class="mono" data-label="Updated">${timeAgo(i.updated_at)}</td>
      </tr>`)}</tbody>
  </table>`;

  const emptyHtml = (title, hint) => html`<div class="empty-state"><p>${title}</p><p class="empty-state__hint">${hint}</p></div>`;

  root.innerHTML = html`
    <div class="list-header">
      <a class="btn btn--ghost" href="#">&larr; Dashboard</a>
      <h2 id="listTitle">${titleFor({ ...query, mine })}</h2>
      ${signedIn ? html`<a class="btn btn--toggle ${mine ? 'is-active' : ''}" id="mineBtn" href="${toggleHref()}" aria-pressed="${mine}"
          title="Only the alerts assigned to you and the alerts you are taking care of">My alerts</a>` : ''}
      <input type="search" id="searchInput" placeholder="Search in this view" aria-label="Search alerts" />
    </div>
    <div id="results"></div>
    <p class="muted-note" id="count" aria-live="polite"></p>`.text;

  const resultsEl = root.querySelector('#results');
  const countEl = root.querySelector('#count');
  const searchEl = root.querySelector('#searchInput');

  async function load() {
    const params = new URLSearchParams();
    for (const key of ['status', 'severity', 'assignee', 'created_by']) if (query[key]) params.set(key, query[key]);
    if (query.active) params.set('active', '1');
    if (mine) params.set('mine', '1');
    if (search) params.set('q', search);

    const list = await api(`/api/incidents?${params}`);
    if (!isCurrent()) return;

    countEl.textContent = list.length ? plural(list.length, 'alert') : '';

    if (!mine) {
      resultsEl.innerHTML = html`<div class="table-wrap">${list.length
        ? tableHtml(list)
        : emptyHtml('No alerts match this view.', 'Go back to the dashboard, or sign in and create a new alert.')}</div>`.text;
      return;
    }

    const { assigned, care } = groupMine(list);
    resultsEl.innerHTML = html`
      <section class="mine-group" data-group="assigned">
        <h3 class="section__title">Assigned to me <span class="faint">(${assigned.length})</span></h3>
        <div class="table-wrap">${assigned.length ? tableHtml(assigned) : emptyHtml('Nothing is assigned to you here.', 'Alerts assigned to you appear in this group.')}</div>
      </section>
      <section class="mine-group" data-group="care">
        <h3 class="section__title">Taking care <span class="faint">(${care.length})</span></h3>
        <div class="table-wrap">${care.length ? tableHtml(care) : emptyHtml('You are not taking care of any alerts here.', 'Open an alert set to “Assigned with take care” and press Take care to add events to it.')}</div>
      </section>`.text;
  }

  let timer;
  searchEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { search = searchEl.value.trim(); load(); }, 250);
  });

  await load();
  return { refresh: load };
}
