import { html } from './util.js';

// Defence in depth: the server only stores http(s) links, but we never render
// an href we haven't checked ourselves.
export function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// Each chip opens in a new tab. data-stop keeps a click on a link from also
// triggering the surrounding card's own click handler.
export function linkChips(links) {
  const usable = (links || []).map((l) => ({ name: l.name, href: safeUrl(l.url) })).filter((l) => l.href);
  if (usable.length === 0) return html``;
  return html`<ul class="link-chips">${usable.map((l) => html`
    <li><a class="link-chip" data-stop href="${l.href}" target="_blank" rel="noopener noreferrer" title="${l.href}">${l.name}<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></a></li>`)}</ul>`;
}
