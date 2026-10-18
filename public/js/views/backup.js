import { api, isSuperUser } from '../api.js';
import { html, plural } from '../util.js';
import { toast, confirmDialog, withBusy } from '../ui.js';

const EXPORTS = [
  {
    scope: 'events',
    title: 'Alerts & events',
    text: 'Every alert with its timeline entries, labels and links.',
    superOnly: false,
  },
  {
    scope: 'users',
    title: 'Users',
    text: 'Accounts and roles. Includes password hashes so logins keep working after a restore.',
    superOnly: true,
  },
  {
    scope: 'all',
    title: 'All data',
    text: 'Alerts, timelines, links and users in a single file. Use this for a full backup.',
    superOnly: true,
  },
];

export async function render(root, ctx) {
  const { refreshSession } = ctx;
  const sup = isSuperUser();

  root.innerHTML = html`
    <div class="list-header">
      <a class="btn btn--ghost" href="#">&larr; Dashboard</a>
      <h2>Backup &amp; export</h2>
    </div>

    <section class="section">
      <h3 class="section__title">Export</h3>
      <div class="export-grid">${EXPORTS.map((x) => html`
        <div class="panel export-card ${x.superOnly && !sup ? 'export-card--locked' : ''}">
          <h4 class="panel__title">${x.title}</h4>
          <p class="export-card__text">${x.text}</p>
          ${x.superOnly && !sup
            ? html`<p class="faint">Super users only</p>`
            : html`<a class="btn btn--primary" href="/api/export?scope=${x.scope}" download>Download .json</a>`}
        </div>`)}
      </div>
      ${sup ? html`<p class="notice">Files that include users contain password hashes. Store them as carefully as you would a password vault.</p>` : ''}
    </section>

    ${sup ? html`
    <section class="section">
      <h3 class="section__title">Import</h3>
      <div class="panel">
        <p class="export-card__text">Choose a file exported from this dashboard. Imported alerts appear on the dashboard straight away.</p>
        <div class="field">
          <label for="importFile">Backup file</label>
          <input type="file" id="importFile" accept="application/json,.json" />
          <span class="field__hint" id="fileInfo"></span>
        </div>
        <fieldset class="field field--radios">
          <legend>How should it be applied?</legend>
          <label class="radio-card"><input type="radio" name="mode" value="merge" checked>
            <span><strong>Merge (safe)</strong><small>Adds anything missing. Alerts and users that already exist are skipped, so nothing is overwritten.</small></span></label>
          <label class="radio-card"><input type="radio" name="mode" value="replace">
            <span><strong>Replace</strong><small>Deletes the current alerts and/or users contained in the file&rsquo;s categories, then restores the file exactly. Use for disaster recovery.</small></span></label>
        </fieldset>
        <button type="button" class="btn btn--primary" id="importBtn" disabled>Import</button>
        <div id="importResult" aria-live="polite"></div>
      </div>
    </section>` : html`<p class="muted-note">Importing a backup is available to super users.</p>`}`.text;

  if (!sup) return undefined;

  const fileInput = root.querySelector('#importFile');
  const importBtn = root.querySelector('#importBtn');
  const info = root.querySelector('#fileInfo');
  const result = root.querySelector('#importResult');
  let payload = null;

  fileInput.addEventListener('change', async () => {
    payload = null;
    importBtn.disabled = true;
    result.innerHTML = '';
    const file = fileInput.files[0];
    if (!file) { info.textContent = ''; return; }
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.app !== 'sre-incident-dashboard') throw new Error('This file was not exported from this dashboard.');
      payload = parsed;
      const parts = [];
      if (Array.isArray(parsed.incidents)) parts.push(plural(parsed.incidents.length, 'alert'));
      if (Array.isArray(parsed.users)) parts.push(plural(parsed.users.length, 'user'));
      info.textContent = `Contains ${parts.join(' and ') || 'nothing importable'}${parsed.exported_at ? `, exported ${new Date(parsed.exported_at).toLocaleString()}` : ''}.`;
      importBtn.disabled = parts.length === 0;
    } catch (err) {
      info.textContent = '';
      toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error');
      fileInput.value = '';
    }
  });

  importBtn.addEventListener('click', async () => {
    if (!payload) return;
    const mode = root.querySelector('input[name="mode"]:checked').value;

    if (mode === 'replace') {
      const what = [Array.isArray(payload.incidents) && 'all current alerts and timelines', Array.isArray(payload.users) && 'all current user accounts'].filter(Boolean).join(' and ');
      const sure = await confirmDialog({
        title: 'Replace existing data?',
        message: `This permanently deletes ${what} and restores the file instead. ${Array.isArray(payload.users) ? 'Everyone, including you, will be signed out. ' : ''}Download a backup first if you are not certain.`,
        confirmLabel: 'Replace data', danger: true,
      });
      if (!sure) return;
    }

    await withBusy(importBtn, async () => {
      try {
        const res = await api(`/api/import?mode=${mode}`, { method: 'POST', body: payload });
        const s = res.summary;
        const lines = [];
        if (s.incidents) lines.push(`Alerts: ${s.incidents.imported} imported${s.incidents.skipped ? `, ${s.incidents.skipped} skipped (already present)` : ''}.`);
        if (s.users) lines.push(`Users: ${s.users.imported} imported${s.users.skipped ? `, ${s.users.skipped} skipped (already present)` : ''}.`);
        result.innerHTML = html`<div class="notice notice--ok"><strong>Import complete.</strong>${lines.map((l) => html`<div>${l}</div>`)}${s.incidents ? html`<a href="#alerts">View alerts &rarr;</a>` : ''}</div>`.text;
        toast('Import complete', 'success');
        fileInput.value = '';
        info.textContent = '';
        payload = null;
        importBtn.disabled = true;
        if (mode === 'replace' && s.users) await refreshSession();
      } catch (err) {
        result.innerHTML = html`<div class="notice notice--error"><strong>Import failed, nothing was changed.</strong><div>${err.message}</div></div>`.text;
      }
    });
    importBtn.disabled = !payload; // withBusy re-enables the button; keep it off until a new file is chosen
  });

  return undefined;
}
