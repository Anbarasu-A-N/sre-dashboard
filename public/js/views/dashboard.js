import { api } from '../api.js';
import { html, plural } from '../util.js';
import { donut, timeBars, workloadBars, stackBar } from '../charts.js';

const RANGES = [7, 14, 30];
let days = 14;

const CREATED_COLOR = '#8b95a1';
const WORKING_COLOR = '#a78bfa';
const COMPLETED_COLOR = '#30a46c';

const alertsHref = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return `#alerts${qs ? `?${qs}` : ''}`;
};

function template(data, meta) {
  const statuses = meta.statuses;
  const statusColor = Object.fromEntries(statuses.map((s) => [s.value, s.color]));

  const tiles = [
    { label: 'Total alerts', count: data.total, href: alertsHref(), color: null },
    ...statuses.map((s) => ({ label: s.value, count: data.byStatus[s.value] || 0, href: alertsHref({ status: s.value }), color: s.color })),
  ];

  const severityGroups = data.severity.map((g) => html`
    <section class="sev-group" aria-label="${g.severity} alerts">
      <header class="sev-group__head">
        <a class="sev-tag sev-tag--lg" href="${alertsHref({ severity: g.severity })}">${g.severity}</a>
        <span class="sev-group__count"><strong>${g.active}</strong> active <span class="faint">of ${g.total}</span></span>
      </header>
      ${stackBar(statuses.map((s) => ({ label: s.value, value: g.byStatus[s.value] || 0, color: s.color })))}
      ${g.alerts.length === 0
        ? html`<p class="sev-group__empty">No active ${g.severity} alerts.</p>`
        : html`<ul class="sev-list">${g.alerts.map((a) => html`
            <li>
              <a class="sev-alert" href="#incident/${a.id}">
                <span class="status-dot" style="--dot:${statusColor[a.status] || '#8b95a1'}" title="${a.status}"></span>
                <span class="sev-alert__title">${a.title}</span>
                <span class="sev-alert__who ${a.assignee ? '' : 'sev-alert__who--none'}">${a.assignee || 'unassigned'}</span>
              </a>
            </li>`)}</ul>`}
      ${g.active > g.alerts.length
        ? html`<a class="sev-group__more" href="${alertsHref({ severity: g.severity, active: '1' })}">View all ${g.active} active →</a>`
        : ''}
    </section>`);

  // --- status donut
  const segments = statuses.map((s) => ({
    label: s.value, value: data.byStatus[s.value] || 0, color: s.color, href: alertsHref({ status: s.value }),
  }));
  const legend = html`<ul class="legend">${segments.map((s) => html`
    <li><a href="${s.href}"><span class="legend__swatch" style="background:${s.color}"></span><span class="legend__name">${s.label}</span><span class="legend__val">${s.value}</span></a></li>`)}</ul>`;

  // --- time
  const t = data.timeline;
  const createdTotal = t.created.reduce((a, b) => a + b, 0);
  const completedTotal = t.completed.reduce((a, b) => a + b, 0);

  // --- workload
  const rows = data.users.map((u) => ({
    label: u.user,
    created: u.created,
    working: u.working,
    createdHref: alertsHref({ created_by: u.user }),
    workingHref: alertsHref({ assignee: u.user, active: '1' }),
  }));
  if (data.unassignedActive > 0) {
    rows.push({
      label: 'Unassigned', created: null, working: data.unassignedActive, muted: true,
      createdHref: '', workingHref: alertsHref({ assignee: '__none__', active: '1' }),
    });
  }

  return html`
    <div class="stats-grid" id="statsGrid">${tiles.map((tile) => html`
      <a class="stat-tile" href="${tile.href}" style="${tile.color ? `--dot:${tile.color}` : ''}">
        <span class="stat-tile__count">${tile.count}</span>
        <span class="stat-tile__label">${tile.label}</span>
      </a>`)}</div>

    <section class="section charts-row">
      <div class="panel">
        <div class="panel__head"><h2 class="panel__title">Alerts by status</h2></div>
        <div class="donut-wrap">
          ${donut(segments, { centerValue: data.total, centerLabel: data.total === 1 ? 'alert' : 'alerts', ariaLabel: 'Alerts by status' })}
          ${legend}
        </div>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Alerts over time</h2>
          <div class="seg" role="group" aria-label="Time range">${RANGES.map((r) => html`
            <button type="button" class="seg__btn ${r === days ? 'is-active' : ''}" data-days="${r}" aria-pressed="${r === days}">${r}d</button>`)}</div>
        </div>
        <ul class="legend legend--inline">
          <li><span class="legend__swatch" style="background:${CREATED_COLOR}"></span>Created <strong>${createdTotal}</strong></li>
          <li><span class="legend__swatch" style="background:${COMPLETED_COLOR}"></span>Completed <strong>${completedTotal}</strong></li>
        </ul>
        ${timeBars({
          labels: t.labels,
          series: [
            { name: 'Created', color: CREATED_COLOR, values: t.created },
            { name: 'Completed', color: COMPLETED_COLOR, values: t.completed },
          ],
          ariaLabel: `Alerts created and completed per day, last ${t.days} days`,
        })}
      </div>
    </section>

    <section class="section">
      <h2 class="section__title">Active alerts by severity</h2>
      <div class="sev-grid">${severityGroups}</div>
    </section>

    <section class="section">
      <div class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Team workload</h2>
          <ul class="legend legend--inline">
            <li><span class="legend__swatch" style="background:${CREATED_COLOR}"></span>Created</li>
            <li><span class="legend__swatch" style="background:${WORKING_COLOR}"></span>Working on now</li>
          </ul>
        </div>
        ${rows.length === 0
          ? html`<p class="muted-note">No alerts yet. Workload appears once alerts are created.</p>`
          : workloadBars(rows, { createdColor: CREATED_COLOR, workingColor: WORKING_COLOR })}
        ${data.unassignedActive > 0
          ? html`<p class="muted-note">${plural(data.unassignedActive, 'active alert')} ${data.unassignedActive === 1 ? 'has' : 'have'} nobody assigned.</p>`
          : ''}
        ${data.usersTruncated > 0 ? html`<p class="muted-note">+${data.usersTruncated} more not shown.</p>` : ''}
      </div>
    </section>`;
}

export async function render(root, ctx) {
  const { isCurrent, meta } = ctx;

  async function load() {
    const data = await api(`/api/dashboard?days=${days}&tz=${new Date().getTimezoneOffset()}`);
    if (!isCurrent()) return;
    root.innerHTML = template(data, meta).text;
  }

  await load();
  if (!isCurrent()) return undefined;

  root.onclick = async (e) => {
    const rangeBtn = e.target.closest('[data-days]');
    if (rangeBtn) {
      days = Number(rangeBtn.dataset.days);
      await load();
      return;
    }
  };

  return { refresh: load };
}
