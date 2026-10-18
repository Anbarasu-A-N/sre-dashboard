import { api, session } from '../api.js';
import { html, raw, timeAgo, formatDateTime, toLocalInputValue, mergeTimeline } from '../util.js';
import { linkChips } from '../links.js';
import { toast, formDialog, confirmDialog } from '../ui.js';

// Semantic dot colours for the standard labels; custom labels use the accent.
const LABEL_COLORS = {
  'issue occurred': '#e5484d',
  identified: '#f5a524',
  update: '#8b95a1',
  rca: '#a78bfa',
  completion: '#30a46c',
};

export async function render(root, ctx) {
  const { isCurrent, meta, params, backTarget } = ctx;
  const statusColor = Object.fromEntries(meta.statuses.map((s) => [s.value, s.color]));
  const modeLabel = (value) => (meta.modes.find((m) => m.value === value) || {}).label || value;

  let incident;
  try {
    incident = await api(`/api/incidents/${encodeURIComponent(params.id)}`);
  } catch (err) {
    if (!isCurrent()) return undefined;
    root.innerHTML = html`<a class="btn btn--ghost" href="${backTarget()}">&larr; Back</a>
      <div class="empty-state"><p>${err.status === 404 ? 'This alert does not exist (it may have been deleted).' : err.message}</p></div>`.text;
    return undefined;
  }
  if (!isCurrent()) return undefined;

  let directory = null;
  async function loadDirectory() {
    if (!directory && session.user) directory = await api('/api/users/directory');
    return directory || [];
  }
  if (incident.permissions.canAssign) await loadDirectory();
  if (!isCurrent()) return undefined;

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function assignmentBlock() {
    const p = incident.permissions;
    const options = (directory || []).map((u) => html`<option value="${u.username}">${u.username}${u.role === 'superuser' ? ' (super user)' : ''}</option>`);
    return html`<span class="assign">
      ${incident.assignee
        ? html`Assigned to <strong>${incident.assignee}</strong>`
        : html`<span class="faint">Unassigned</span>`}
      ${p.canAssignSelf && !freePickup() ? html`<button type="button" class="btn btn--small btn--primary" data-act="assign-self" title="Make yourself the assignee of this alert">Assign to me</button>` : ''}
      ${p.canAssign
        ? html`<select class="select--small" data-act="assign" aria-label="Assign this alert to someone">
            <option value="" selected disabled>Assign to…</option>
            <option value="__none__">Unassigned</option>
            ${options}
          </select>`
        : ''}
    </span>`;
  }

  // Created with "Nobody yet" and still nobody assigned: anyone can either assign themselves or just take care.
  const freePickup = () => incident.mode === 'takecare' && incident.single_holder === 1 && !incident.assignee;

  // "Taking care" is separate from being assigned: it only lets a person add timeline events,
  // and any number of people can do it at once.
  function careBlock() {
    const p = incident.permissions;
    const carers = incident.carers || [];
    if (incident.mode !== 'takecare' && carers.length === 0) return '';
    const pickup = freePickup();
    return html`<span class="care">
      ${carers.length
        ? html`Taking care: <strong>${carers.join(', ')}</strong>`
        : html`<span class="faint">${pickup ? 'Nobody is assigned or taking care' : 'Nobody taking care yet'}</span>`}
      ${pickup && p.canAssignSelf ? html`<button type="button" class="btn btn--small btn--primary" data-act="assign-self" title="Become the assignee: you work on the alert fully, and only you, the creator and super users can then change the assignment or the status">Assign to me</button>` : ''}
      ${p.canTakeCare ? html`<button type="button" class="btn btn--small btn--primary" data-act="care" title="Add timeline events only. You will not be assigned, and others can take care too.">Take care</button>` : ''}
      ${p.canLeaveCare ? html`<button type="button" class="btn btn--small btn--ghost" data-act="leave-care">Stop taking care</button>` : ''}
    </span>`;
  }

  function notices() {
    const p = incident.permissions;
    const out = [];

    if (incident.status === 'On Hold') {
      out.push(incident.hold_auto
        ? `This alert was put On Hold automatically: nothing was added to its timeline for ${meta.autoHoldDays} days. Adding a timeline update puts it back to Ongoing.`
        : 'This alert is On Hold (set by hand). It stays on hold until its status is changed.');
    }
    if (session.user && !p.canEdit) {
      const who = incident.assignee;
      // Once somebody is assigned, only they, the creator and super users can change the assignment or the status.
      const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
      const lock = who
        ? (sameName(who, incident.created_by)
          ? `Only ${who} (the creator) or a super user can change the assignment or the status.`
          : `Only ${who}, ${incident.created_by} (the creator) or a super user can change the assignment or the status.`)
        : '';
      if (p.canAddEvent) {
        out.push(who
          ? `You are taking care of this alert, so you can add timeline events. ${lock}`
          : (freePickup()
            ? 'You are taking care of this alert, so you can add timeline events. Press "Assign to me" if you want to work on it fully.'
            : 'You are taking care of this alert, so you can add timeline events. Everything else is managed by the assignee or the creator.'));
      } else if (p.canTakeCare && who) {
        out.push(`Assigned to ${who}. ${lock} Press "Take care" to add timeline events.`);
      } else if (p.canTakeCare && freePickup()) {
        out.push('Nobody is assigned yet. Press "Assign to me" to work on it fully (then only you, the creator and super users can change the assignment or the status), or "Take care" to add timeline events. Several people can take care at once.');
      } else if (p.canTakeCare) {
        out.push('Nobody is assigned. Press "Take care" to add timeline events; you will not be assigned.');
      } else if (incident.mode === 'private') {
        out.push('This alert is private: only its creator and super users can work on it.');
      } else if (p.canAssignSelf) {
        out.push('Nobody is assigned yet. Press "Assign to me" to work on this alert.');
      } else if (incident.status === 'Completed' && incident.mode === 'takecare') {
        out.push('This alert is completed, so nobody new can take care of it.');
      } else if (who) {
        out.push(`Assigned to ${who}. ${lock}`);
      } else {
        out.push('You can view this alert but not change it.');
      }
    }
    return out.map((text) => html`<p class="notice">${text}</p>`);
  }

  function statusControl() {
    if (!incident.permissions.canEdit) {
      return html`<span class="status-pill status-pill--lg" style="--dot:${statusColor[incident.status] || '#8b95a1'}">${incident.status}</span>`;
    }
    return html`<select class="status-select" id="statusSelect" style="--dot:${statusColor[incident.status] || '#8b95a1'}" aria-label="Status"
        title="On Hold can be set by hand, and is also applied automatically after ${meta.autoHoldDays} days without a timeline update.">
      ${meta.statuses.map((s) => html`<option value="${s.value}" ${s.value === incident.status ? raw('selected') : ''}>${s.value}</option>`)}
    </select>`;
  }

  function eventCard(e) {
    const canEdit = incident.permissions.canEdit;
    const color = LABEL_COLORS[e.label.trim().toLowerCase()] || 'var(--accent)';
    return html`<li class="timeline-item ${canEdit ? 'is-editable' : ''}" data-id="${e.id}">
      <span class="timeline-item__dot" style="--dot:${color}"></span>
      <div class="timeline-item__card">
        <div class="timeline-item__top">
          <span class="timeline-item__label">${e.label}</span>
          <span class="timeline-item__time">${formatDateTime(e.event_time)}</span>
        </div>
        ${e.note ? html`<div class="timeline-item__note">${e.note}</div>` : ''}
        ${linkChips(e.links)}
        <div class="timeline-item__foot">
          <span class="timeline-item__by">logged by ${e.created_by}</span>
          ${canEdit ? html`<span class="timeline-item__tools"><button type="button" class="btn btn--small btn--ghost" data-edit="${e.id}">Edit</button></span>` : ''}
        </div>
      </div>
    </li>`;
  }

  // Automatic comments (who took care, who assigned, status changes...) sit between the events.
  function activityRow(a) {
    return html`<li class="timeline-item timeline-item--activity" data-kind="${a.kind}">
      <span class="timeline-item__dot"></span>
      <div class="activity ${a.actor === 'system' ? 'activity--system' : ''}">
        <span class="activity__text">${a.text}</span>
        <span class="activity__time">${formatDateTime(a.created_at)}</span>
      </div>
    </li>`;
  }

  function draw() {
    const p = incident.permissions;
    const items = mergeTimeline(incident.events, incident.activity || []);

    root.innerHTML = html`
      <a class="btn btn--ghost" href="${backTarget()}">&larr; Back</a>

      <section class="incident-head">
        <div class="incident-head__top">
          <div class="incident-head__main">
            <h2>${incident.title}${incident.mode === 'private' ? html` <span class="tag" title="Only the creator and super users can work on this alert">Only me</span>` : ''}</h2>
            ${incident.description ? html`<p class="incident-head__desc">${incident.description}</p>` : ''}
            ${linkChips(incident.links)}
          </div>
          <div class="incident-head__controls">
            ${statusControl()}
            ${p.canEdit ? html`<button type="button" class="btn btn--ghost" data-act="edit">Edit</button>` : ''}
          </div>
        </div>
        <div class="incident-head__meta">
          <span class="sev-tag">${incident.severity}</span>
          <span>Opened by <strong>${incident.created_by}</strong></span>
          ${assignmentBlock()}
          ${careBlock()}
          <span class="mono">Created ${timeAgo(incident.created_at)}</span>
          ${incident.closed_at ? html`<span class="mono">Closed ${timeAgo(incident.closed_at)}</span>` : html`<span class="mono" title="An Ongoing alert goes On Hold after ${meta.autoHoldDays} days without a timeline update">Last update ${timeAgo(incident.last_update_at)}</span>`}
        </div>
        ${notices()}
      </section>

      <section class="timeline-section">
        <div class="timeline-section__header">
          <h2>Timeline</h2>
          ${p.canAddEvent ? html`<button type="button" class="btn btn--primary" data-act="add-event">+ Add event</button>` : ''}
        </div>
        <p class="timeline-section__hint">Ordered by the time each entry happened. Grey lines are recorded automatically.</p>
        ${incident.events.length === 0
          ? html`<p class="muted-note">${p.canAddEvent ? 'No events yet. Log when the issue occurred to start the timeline.' : 'No events have been logged yet.'}</p>`
          : ''}
        ${items.length === 0 ? '' : html`<ol class="timeline" id="timeline">${items.map((it) => (it.type === 'event' ? eventCard(it.data) : activityRow(it.data)))}</ol>`}
      </section>`.text;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  // The user list is needed as soon as an alert becomes assignable (e.g. after switching away from "Only me").
  const adopt = async (updated) => {
    incident = updated;
    if (incident.permissions.canAssign) await loadDirectory();
    draw();
  };
  const reload = async () => { await adopt(await api(`/api/incidents/${incident.id}`)); };
  const fail = (err) => { toast(err.message, 'error'); reload().catch(() => {}); };

  async function assignTo(username, successText) {
    try {
      await adopt(await api(`/api/incidents/${incident.id}/assign`, { method: 'POST', body: { assignee: username } }));
      toast(successText || (username ? `Assigned to ${username}` : 'Alert is now unassigned'), 'success');
    } catch (err) { fail(err); }
  }

  // Take care = may add timeline events. Not an assignment.
  async function takeCare(start, releaseUser) {
    try {
      const url = `/api/incidents/${incident.id}/care${releaseUser ? `?user=${encodeURIComponent(releaseUser)}` : ''}`;
      await adopt(await api(url, { method: start ? 'POST' : 'DELETE' }));
      if (releaseUser) toast(`${releaseUser} was released: the alert is free again`, 'success');
      else toast(start ? 'You are taking care of this alert: you can now add timeline events' : 'You stopped taking care of this alert', 'success');
    } catch (err) { fail(err); }
  }

  async function openEditDialog() {
    const p = incident.permissions;
    let deleted = false;

    const fields = [
      { name: 'title', label: 'Title', required: true, maxlength: 200, value: incident.title },
      { name: 'description', label: 'Description', type: 'textarea', value: incident.description || '', maxlength: 5000 },
      { name: 'severity', label: 'Severity', type: 'select', value: incident.severity, options: meta.severities.map((s) => ({ value: s, label: s })) },
    ];
    if (p.canChangeMode) {
      fields.push({
        name: 'mode', label: 'Who can continue this alert?', type: 'radio', value: incident.mode,
        options: meta.modes.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
      });
    }
    fields.push({ name: 'links', label: 'Links', type: 'links', value: incident.links, hint: 'Add any number of named links (dashboards, runbooks, tickets). Each opens in a new tab.' });

    const ok = await formDialog({
      title: 'Edit alert',
      submitLabel: 'Save changes',
      fields,
      secondary: p.canDelete ? {
        label: 'Delete alert',
        danger: true,
        onClick: async () => {
          const sure = await confirmDialog({
            title: 'Delete this alert?',
            message: 'The alert and its whole timeline will be permanently removed. Consider exporting a backup first.',
            confirmLabel: 'Delete alert', danger: true,
          });
          if (!sure) return false;
          await api(`/api/incidents/${incident.id}`, { method: 'DELETE' });
          deleted = true;
          return true;
        },
      } : undefined,
      onSubmit: async (v) => {
        const body = { title: v.title.trim(), description: v.description.trim(), severity: v.severity, links: v.links };
        if (v.mode && v.mode !== incident.mode) body.mode = v.mode;
        await adopt(await api(`/api/incidents/${incident.id}`, { method: 'PATCH', body }));
      },
    });

    if (ok && deleted) { toast('Alert deleted', 'success'); location.hash = backTarget(); }
    else if (ok) toast('Alert updated', 'success');
  }

  async function openEventDialog(existing) {
    // The picker only has minute precision. If the user leaves the time alone we keep full precision:
    // "now" for a new event (so it sorts after automatic comments logged seconds earlier), or the
    // untouched original for an edit.
    const defaultTime = toLocalInputValue(existing?.event_time);
    const ok = await formDialog({
      title: existing ? 'Edit timeline event' : 'Add timeline event',
      submitLabel: existing ? 'Save changes' : 'Add event',
      description: 'The timeline is ordered by this time, so you can backfill an earlier event.',
      fields: [
        { name: 'label', label: 'Label', required: true, maxlength: 80, value: existing?.label || '', presets: meta.labelPresets, placeholder: 'Pick one above, or type your own' },
        { name: 'event_time', label: 'Time it happened', type: 'datetime-local', required: true, value: defaultTime },
        { name: 'note', label: 'Notes', type: 'textarea', value: existing?.note || '', maxlength: 5000, placeholder: 'What happened, what you found, what you did' },
        { name: 'links', label: 'Links', type: 'links', value: existing?.links || [], hint: 'Add any number of named links. Each opens in a new tab.' },
      ],
      secondary: existing ? {
        label: 'Delete',
        danger: true,
        onClick: async () => {
          const sure = await confirmDialog({ title: 'Delete this timeline entry?', message: `“${existing.label}” will be removed from the timeline.`, confirmLabel: 'Delete', danger: true });
          if (!sure) return false;
          await api(`/api/events/${existing.id}`, { method: 'DELETE' });
          return true;
        },
      } : undefined,
      onSubmit: async (v) => {
        const untouched = v.event_time === defaultTime;
        const eventTime = untouched ? (existing ? existing.event_time : new Date().toISOString()) : new Date(v.event_time).toISOString();
        const body = { label: v.label.trim(), event_time: eventTime, note: v.note.trim(), links: v.links };
        if (existing) await api(`/api/events/${existing.id}`, { method: 'PATCH', body });
        else await api(`/api/incidents/${incident.id}/events`, { method: 'POST', body });
      },
    });
    if (ok) await reload();
  }

  // ------------------------------------------------------------------
  // Event wiring (delegated, so re-drawing never loses handlers)
  // ------------------------------------------------------------------

  root.onclick = (e) => {
    if (e.target.closest('a[data-stop]')) return; // link chips open in a new tab
    const act = e.target.closest('button[data-act]');
    if (act) {
      if (act.dataset.act === 'edit') openEditDialog();
      else if (act.dataset.act === 'add-event') openEventDialog();
      else if (act.dataset.act === 'assign-self') assignTo(session.user.username, 'The alert is now assigned to you');
      else if (act.dataset.act === 'care') takeCare(true);
      else if (act.dataset.act === 'leave-care') takeCare(false);
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) { openEventDialog(incident.events.find((ev) => String(ev.id) === edit.dataset.edit)); return; }

    const card = e.target.closest('.timeline-item.is-editable .timeline-item__card');
    if (card && !e.target.closest('button, select, a')) {
      const id = card.closest('.timeline-item').dataset.id;
      openEventDialog(incident.events.find((ev) => String(ev.id) === id));
    }
  };

  root.onchange = async (e) => {
    if (e.target.id === 'statusSelect') {
      try {
        await adopt(await api(`/api/incidents/${incident.id}`, { method: 'PATCH', body: { status: e.target.value } }));
      } catch (err) { fail(err); }
    } else if (e.target.dataset.act === 'assign') {
      const value = e.target.value;
      assignTo(value === '__none__' ? '' : value);
    }
  };

  draw();
  return {
    refresh: async () => {
      try {
        await reload();
      } catch (err) {
        if (err.status !== 404) throw err;
        toast('This alert was deleted', 'error');
        location.hash = backTarget();
      }
    },
  };
}
