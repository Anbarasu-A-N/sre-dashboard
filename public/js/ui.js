import { html, raw } from './util.js';

// ---------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------

export function toast(message, type = 'info') {
  let region = document.getElementById('toasts');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toasts';
    region.className = 'toast-region';
    document.body.appendChild(region);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
}

// Run an async action while a button is disabled (prevents double submits).
export async function withBusy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Multi-link editor: any number of { name, url } rows
// ---------------------------------------------------------------------

function createLinkEditor(container, initial = []) {
  const rows = document.createElement('div');
  rows.className = 'link-editor__rows';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn--ghost btn--small';
  addBtn.textContent = '+ Add link';

  function addRow(link = { name: '', url: '' }) {
    const row = document.createElement('div');
    row.className = 'link-row';
    row.innerHTML = `
      <input type="text" class="link-row__name" placeholder="Name, e.g. Grafana" maxlength="80" aria-label="Link name">
      <input type="text" class="link-row__url" placeholder="https://…" maxlength="2000" inputmode="url" aria-label="Link URL">
      <button type="button" class="icon-btn" aria-label="Remove this link" title="Remove">&#x2715;</button>`;
    row.querySelector('.link-row__name').value = link.name || '';
    row.querySelector('.link-row__url').value = link.url || '';
    row.querySelector('button').addEventListener('click', () => row.remove());
    rows.appendChild(row);
    return row;
  }

  initial.forEach(addRow);
  addBtn.addEventListener('click', () => addRow().querySelector('.link-row__name').focus());
  container.append(rows, addBtn);

  return {
    getLinks() {
      return [...rows.children]
        .map((row) => ({
          name: row.querySelector('.link-row__name').value.trim(),
          url: row.querySelector('.link-row__url').value.trim(),
        }))
        .filter((l) => l.name || l.url)
        .map((l) => {
          if (!l.url) throw new Error(`The link "${l.name}" needs a URL`);
          return l;
        });
    },
  };
}

// ---------------------------------------------------------------------
// Generic form dialog
//
// fields: [{ name, label, type, value, required, placeholder, hint, maxlength,
//            options (select/radio), presets (text), rows (textarea),
//            autocomplete, visible: (values) => boolean }]
// type: text | password | textarea | select | radio | datetime-local | links
//
// onSubmit(values) may throw; the message is shown inside the dialog.
// Resolves with onSubmit's return value (or true), or null if cancelled.
// ---------------------------------------------------------------------

let dialogSeq = 0;

function fieldMarkup(f, id) {
  const hint = f.hint ? html`<span class="field__hint">${f.hint}</span>` : '';
  const req = f.required ? raw(' required') : '';
  const max = f.maxlength ? raw(` maxlength="${Number(f.maxlength)}"`) : '';
  const wrap = (inner) => html`<div class="field" data-field="${f.name}">${inner}</div>`;

  switch (f.type) {
    case 'textarea':
      return wrap(html`<label for="${id}">${f.label}</label>
        <textarea id="${id}" rows="${f.rows || 3}" placeholder="${f.placeholder || ''}"${max}${req}>${f.value ?? ''}</textarea>${hint}`);

    case 'select':
      return wrap(html`<label for="${id}">${f.label}</label>
        <select id="${id}"${req}>${f.options.map((o) => html`<option value="${o.value}" ${o.value === f.value ? raw('selected') : ''}>${o.label}</option>`)}</select>${hint}`);

    case 'radio':
      return html`<fieldset class="field field--radios" data-field="${f.name}">
        <legend>${f.label}</legend>
        ${f.options.map((o) => html`<label class="radio-card">
          <input type="radio" name="${id}" value="${o.value}" ${o.value === f.value ? raw('checked') : ''}>
          <span><strong>${o.label}</strong>${o.hint ? html`<small>${o.hint}</small>` : ''}</span>
        </label>`)}
      </fieldset>`;

    case 'links':
      return html`<div class="field" data-field="${f.name}">
        <span class="field__label">${f.label}</span>
        <div class="link-editor" data-link-editor></div>${hint}
      </div>`;

    default: {
      const presets = f.presets
        ? html`<div class="preset-row" data-presets>${f.presets.map((p) => html`<button type="button" class="btn btn--preset" data-preset="${p}">${p}</button>`)}</div>`
        : '';
      return wrap(html`<label for="${id}">${f.label}</label>${presets}
        <input id="${id}" type="${f.type || 'text'}" value="${f.value ?? ''}" placeholder="${f.placeholder || ''}"
          autocomplete="${f.autocomplete || 'off'}"${max}${req}>${hint}`);
    }
  }
}

export function formDialog({ title, description, submitLabel = 'Save', fields = [], secondary, danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const uid = `fd${++dialogSeq}`;
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = html`<form class="form-dialog">
      <h2>${title}</h2>
      ${description ? html`<p class="form-dialog__desc">${description}</p>` : ''}
      ${fields.map((f, i) => fieldMarkup(f, `${uid}-${i}`))}
      <p class="form-error" role="alert" hidden></p>
      <div class="modal__actions">
        ${secondary ? html`<button type="button" class="btn ${secondary.danger ? 'btn--danger' : 'btn--ghost'}" data-secondary>${secondary.label}</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="btn btn--ghost" data-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? 'btn--danger-solid' : 'btn--primary'}" data-submit>${submitLabel}</button>
      </div>
    </form>`.text;

    const form = dlg.querySelector('form');
    const errorEl = dlg.querySelector('.form-error');
    const submitBtn = dlg.querySelector('[data-submit]');
    const secondaryBtn = dlg.querySelector('[data-secondary]');
    const cancelBtn = dlg.querySelector('[data-cancel]');

    const wrapFor = (name) => dlg.querySelector(`[data-field="${name}"]`);
    const editors = {};
    for (const f of fields) {
      if (f.type === 'links') {
        editors[f.name] = createLinkEditor(wrapFor(f.name).querySelector('[data-link-editor]'), f.value || []);
      }
      if (f.presets) {
        const input = wrapFor(f.name).querySelector('input');
        const chips = [...wrapFor(f.name).querySelectorAll('[data-preset]')];
        const sync = () => chips.forEach((c) => c.classList.toggle('is-active', c.dataset.preset === input.value));
        chips.forEach((c) => c.addEventListener('click', () => { input.value = c.dataset.preset; sync(); }));
        input.addEventListener('input', sync);
        sync();
      }
    }

    // forVisibility = true: skip things that can throw while the user is mid-typing.
    function readValues(skipHidden, forVisibility = false) {
      const values = {};
      for (const f of fields) {
        const wrap = wrapFor(f.name);
        if (skipHidden && wrap.hidden) continue;
        if (f.type === 'radio') values[f.name] = wrap.querySelector('input:checked')?.value;
        else if (f.type === 'links') values[f.name] = forVisibility ? [] : editors[f.name].getLinks();
        else values[f.name] = wrap.querySelector('input, select, textarea').value;
      }
      return values;
    }

    function refreshVisibility() {
      const current = readValues(false, true);
      for (const f of fields) {
        if (!f.visible) continue;
        const show = !!f.visible(current);
        const wrap = wrapFor(f.name);
        wrap.hidden = !show;
        wrap.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = !show; });
      }
    }
    form.addEventListener('input', refreshVisibility);
    form.addEventListener('change', refreshVisibility);
    refreshVisibility();

    let settled = false;
    const finish = (result) => { settled = true; dlg.close(); resolve(result); };
    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
    const setBusy = (busy) => {
      submitBtn.disabled = busy;
      if (secondaryBtn) secondaryBtn.disabled = busy;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      let values;
      try { values = readValues(true); } catch (err) { showError(err.message); return; }
      setBusy(true);
      try {
        const result = await onSubmit(values);
        finish(result === undefined ? true : result);
      } catch (err) {
        showError(err.message || 'Something went wrong');
        setBusy(false);
      }
    });

    if (secondaryBtn) {
      secondaryBtn.addEventListener('click', async () => {
        errorEl.hidden = true;
        setBusy(true);
        try {
          const result = await secondary.onClick();
          if (result === false) setBusy(false);
          else finish(result === undefined ? true : result);
        } catch (err) {
          showError(err.message || 'Something went wrong');
          setBusy(false);
        }
      });
    }

    cancelBtn.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { dlg.remove(); if (!settled) resolve(null); });

    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

export const confirmDialog = ({ title, message, confirmLabel = 'Confirm', danger = false }) =>
  formDialog({ title, description: message, submitLabel: confirmLabel, danger, onSubmit: async () => true }).then(Boolean);

export const hasOpenDialog = () => !!document.querySelector('dialog[open]');
