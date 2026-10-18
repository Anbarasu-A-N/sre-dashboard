// Pure helpers (no DOM access) so they can be unit-tested in Node.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Trusted markup. Everything interpolated into html`` is escaped unless it is
// itself the result of html`` / raw(), so forgetting to escape is not possible.
export class Raw {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}
export const raw = (text) => new Raw(text);

function render(value) {
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

// ---------- time ----------

export function timeAgo(iso, now = Date.now()) {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

export function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDay(isoDay) {
  // isoDay is "YYYY-MM-DD" (already the viewer's local calendar day)
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function toLocalInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- timeline ----------

// One chronological list of the people-written events and the automatic activity comments
// (assigned / took care / unassigned / status...). At the same instant, events come first.
export function mergeTimeline(events, activity) {
  const items = [
    ...events.map((data) => ({ type: 'event', time: data.event_time, rank: 0, id: data.id, data })),
    ...activity.map((data) => ({ type: 'activity', time: data.created_at, rank: 1, id: data.id, data })),
  ];
  items.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.rank - b.rank || a.id - b.id);
  return items;
}
