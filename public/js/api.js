// Thin fetch wrapper + the signed-in user for this tab.

export const session = { user: null };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onSessionLost = () => {};
export const setSessionLostHandler = (fn) => { onSessionLost = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    // A 401 while we believe we're signed in means the session expired or was revoked.
    if (res.status === 401 && session.user && path !== '/api/auth/login') {
      session.user = null;
      onSessionLost();
    }
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export async function loadSession() {
  const { user } = await api('/api/auth/me');
  session.user = user;
  return user;
}

export const isSignedIn = () => !!session.user;
export const isSuperUser = () => !!session.user && session.user.role === 'superuser';
