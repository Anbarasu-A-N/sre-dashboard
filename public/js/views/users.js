import { api, session } from '../api.js';
import { html, raw, formatDateTime } from '../util.js';
import { toast, formDialog, confirmDialog } from '../ui.js';

const ROLE_LABEL = { user: 'User', superuser: 'Super user' };
const ROLE_OPTIONS = [
  { value: 'user', label: 'User: can create alerts and work on their own or assigned ones' },
  { value: 'superuser', label: 'Super user: can do everything, including managing users' },
];

export async function render(root, ctx) {
  const { isCurrent, refreshSession } = ctx;

  function template(users) {
    return html`
      <div class="list-header">
        <a class="btn btn--ghost" href="#">&larr; Dashboard</a>
        <h2>Users</h2>
        <button type="button" class="btn btn--primary" data-act="add">+ Add user</button>
      </div>
      <div class="table-wrap">
        <table class="incident-table users-table">
          <thead><tr><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${users.map((u) => html`
            <tr>
              <td class="title-cell">${u.username}${u.id === session.user.id ? html` <span class="tag">You</span>` : ''}${u.must_change_password ? html` <span class="tag" title="They have not changed the password you set yet">Temporary password</span>` : ''}</td>
              <td>
                <select class="select--small" data-role="${u.id}" aria-label="Role for ${u.username}">
                  ${Object.entries(ROLE_LABEL).map(([value, label]) => html`<option value="${value}" ${value === u.role ? raw('selected') : ''}>${label}</option>`)}
                </select>
              </td>
              <td class="mono">${formatDateTime(u.created_at)}</td>
              <td class="row-actions">
                <button type="button" class="btn btn--small btn--ghost" data-reset="${u.id}">Reset password</button>
                <button type="button" class="btn btn--small btn--danger" data-delete="${u.id}" ${u.id === session.user.id ? raw('disabled title="You cannot delete your own account"') : ''}>Delete</button>
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      <p class="muted-note">Passwords must be at least 8 characters. Resetting a password signs that person out everywhere.</p>`;
  }

  let users = await api('/api/users');
  if (!isCurrent()) return undefined;

  const draw = () => { root.innerHTML = template(users).text; };
  const reload = async () => { users = await api('/api/users'); if (isCurrent()) draw(); };
  const find = (id) => users.find((u) => String(u.id) === String(id));
  draw();

  async function addUser() {
    const ok = await formDialog({
      title: 'Add user',
      submitLabel: 'Create user',
      fields: [
        { name: 'username', label: 'Username', required: true, maxlength: 32, placeholder: 'e.g. jsmith', hint: 'Letters, numbers, dot, dash or underscore.', autocomplete: 'off' },
        { name: 'password', label: 'Temporary password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 8 characters. Ask them to change it after signing in.' },
        { name: 'role', label: 'Role', type: 'select', value: 'user', options: ROLE_OPTIONS },
      ],
      onSubmit: (v) => api('/api/users', { method: 'POST', body: { username: v.username, password: v.password, role: v.role } }),
    });
    if (ok) { toast('User created', 'success'); await reload(); }
  }

  async function resetPassword(user) {
    const ok = await formDialog({
      title: `Reset password for ${user.username}`,
      submitLabel: 'Set new password',
      description: 'They will be signed out on every device.',
      fields: [{ name: 'password', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 8 characters.' }],
      onSubmit: (v) => api(`/api/users/${user.id}`, { method: 'PATCH', body: { password: v.password } }),
    });
    if (ok) toast(`Password reset for ${user.username}`, 'success');
  }

  async function deleteUser(user) {
    const sure = await confirmDialog({
      title: `Delete ${user.username}?`,
      message: 'They will no longer be able to sign in. Alerts they created or were assigned keep their name.',
      confirmLabel: 'Delete user', danger: true,
    });
    if (!sure) return;
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      toast('User deleted', 'success');
      await reload();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function changeRole(user, role, selectEl) {
    if (user.id === session.user.id && role !== 'superuser') {
      const sure = await confirmDialog({
        title: 'Remove your own super user access?',
        message: 'You will immediately lose access to user management and backups.',
        confirmLabel: 'Change my role', danger: true,
      });
      if (!sure) { selectEl.value = user.role; return; }
    }
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: { role } });
      toast(`${user.username} is now ${ROLE_LABEL[role].toLowerCase()}`, 'success');
      if (user.id === session.user.id) await refreshSession();
      else await reload();
    } catch (err) {
      toast(err.message, 'error');
      selectEl.value = user.role;
    }
  }

  root.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.act === 'add') addUser();
    else if (btn.dataset.reset) resetPassword(find(btn.dataset.reset));
    else if (btn.dataset.delete) deleteUser(find(btn.dataset.delete));
  };
  root.onchange = (e) => {
    if (e.target.dataset.role) changeRole(find(e.target.dataset.role), e.target.value, e.target);
  };
  return undefined;
}
