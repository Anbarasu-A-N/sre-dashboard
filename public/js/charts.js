// Dependency-free charts. Pure functions: data in, safe markup out.
// Bars are HTML/CSS (not scaled SVG) so text stays readable on phones.

import { html, formatDay } from './util.js';

// A y-axis that always ends on a round number and uses whole counts.
export function niceScale(maxValue, targetTicks = 4) {
  if (!(maxValue > 4)) return { max: 4, step: 1 };
  const rawStep = maxValue / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / magnitude;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = Math.max(1, nice * magnitude);
  return { max: Math.ceil(maxValue / step) * step, step };
}

// segments: [{ label, value, color, href }]
export function donut(segments, { size = 168, thickness = 24, centerValue = '', centerLabel = '', ariaLabel = 'Chart' } = {}) {
  const live = segments.filter((s) => s.value > 0);
  const total = live.reduce((sum, s) => sum + s.value, 0);
  const r = (size - thickness) / 2;
  const mid = size / 2;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs = live.map((s) => {
    const length = (s.value / total) * circumference;
    const gap = live.length > 1 ? Math.min(2, length * 0.5) : 0;
    const dash = Math.max(length - gap, 0.01);
    const arc = html`<circle class="donut__seg" data-href="${s.href}" cx="${mid}" cy="${mid}" r="${r}" fill="none"
      stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${dash.toFixed(3)} ${(circumference - dash).toFixed(3)}"
      stroke-dashoffset="${(-offset).toFixed(3)}" transform="rotate(-90 ${mid} ${mid})"><title>${s.label}: ${s.value}</title></circle>`;
    offset += length;
    return arc;
  });

  return html`<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${ariaLabel}">
    <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${thickness}"></circle>
    ${arcs}
    <text class="donut__value" x="${mid}" y="${mid + 2}" text-anchor="middle">${centerValue}</text>
    <text class="donut__label" x="${mid}" y="${mid + 20}" text-anchor="middle">${centerLabel}</text>
  </svg>`;
}

// labels: ["YYYY-MM-DD", ...]; series: [{ name, color, values: [] }]
export function timeBars({ labels, series, ariaLabel = 'Alerts over time' }) {
  const n = labels.length;
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  const { max, step } = niceScale(peak);

  const ticks = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);

  const every = n <= 7 ? 1 : n <= 14 ? 2 : Math.ceil(n / 10);
  const firstLabelled = (n - 1) % every; // labels are counted back from today so today is always shown
  const labelFor = (day, i) => {
    if ((n - 1 - i) % every !== 0) return '';
    const dayOfMonth = Number(day.slice(8, 10));
    return i === firstLabelled || dayOfMonth === 1 ? formatDay(day) : String(dayOfMonth);
  };

  return html`<div class="bars" role="img" aria-label="${ariaLabel}">
    <div class="bars__axis">${ticks.map((t) => html`<span style="bottom:${(t / max) * 100}%">${t}</span>`)}</div>
    <div class="bars__plot">
      <div class="bars__grid">${ticks.map((t) => html`<i style="bottom:${(t / max) * 100}%"></i>`)}</div>
      <div class="bars__cols">${labels.map((day, i) => {
        const summary = `${formatDay(day)}: ${series.map((s) => `${s.name} ${s.values[i]}`).join(', ')}`;
        return html`<div class="bars__col" title="${summary}">${series.map((s) => {
          const v = s.values[i];
          const pct = v > 0 ? Math.max((v / max) * 100, 3) : 0;
          return html`<span class="bar" style="height:${pct}%;--c:${s.color}"></span>`;
        })}</div>`;
      })}</div>
    </div>
    <div class="bars__labels">${labels.map((day, i) => html`<span>${labelFor(day, i)}</span>`)}</div>
  </div>`;
}

// rows: [{ label, createdHref, workingHref, created, working, muted }]
// created === null hides that bar (used for the "Unassigned" row).
export function workloadBars(rows, { createdColor, workingColor }) {
  const peak = Math.max(1, ...rows.flatMap((r) => [r.created ?? 0, r.working]));
  const bar = (name, value, href, color) => {
    const pct = value > 0 ? Math.max((value / peak) * 100, 2) : 0;
    return html`<a class="wl-bar ${value === 0 ? 'wl-bar--zero' : ''}" href="${href}" title="${name}: ${value}">
      <span class="wl-bar__track"><span class="wl-bar__fill" style="width:${pct}%;--c:${color}"></span></span>
      <span class="wl-bar__val">${value}</span>
    </a>`;
  };

  return html`<div class="wl">${rows.map((r) => html`
    <div class="wl-row ${r.muted ? 'wl-row--muted' : ''}">
      <div class="wl-name" title="${r.label}">${r.label}</div>
      <div class="wl-bars">
        ${r.created === null ? '' : bar('Created', r.created, r.createdHref, createdColor)}
        ${bar('Working on', r.working, r.workingHref, workingColor)}
      </div>
    </div>`)}</div>`;
}

// One thin stacked bar showing how alerts split across statuses.
// parts: [{ label, value, color }]
export function stackBar(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return html`<div class="stack stack--empty" aria-hidden="true"></div>`;
  return html`<div class="stack" role="img" aria-label="${parts.filter((p) => p.value).map((p) => `${p.label} ${p.value}`).join(', ')}">
    ${parts.filter((p) => p.value > 0).map((p) => html`<span style="flex:${p.value};background:${p.color}" title="${p.label}: ${p.value}"></span>`)}
  </div>`;
}
