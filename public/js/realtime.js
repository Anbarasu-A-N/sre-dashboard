// Live updates: the server pushes tiny "something changed" pings, and the page re-fetches what it is showing.
// EventSource reconnects by itself; after a dropped connection we refresh once to catch up on what was missed.
// If the stream is blocked (some proxies), main.js still polls as a fallback.

let source = null;
let hasOpened = false;
let timer = null;
let handlers = { data: () => {}, notify: () => {} };

function connect() {
  if (typeof EventSource === 'undefined') return;
  source = new EventSource('/api/stream');
  // Several changes in a burst become one refresh.
  source.addEventListener('data', () => {
    clearTimeout(timer);
    timer = setTimeout(() => handlers.data(), 250);
  });
  source.addEventListener('notify', () => handlers.notify());
  source.onopen = () => {
    if (hasOpened) handlers.data(); // we were disconnected for a while: catch up
    hasOpened = true;
  };
}

export function startRealtime(h) {
  handlers = h;
  connect();
}

// The stream is tied to who is signed in, so reconnect after signing in or out.
export function restartRealtime() {
  if (source) source.close();
  hasOpened = false;
  connect();
}
