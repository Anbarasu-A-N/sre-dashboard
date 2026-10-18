'use strict';

// Live updates over Server-Sent Events (plain HTTP, no dependencies).
//
// The stream carries NO data, only pings:
//   event: data    -> "something changed", the browser re-fetches whatever it is showing
//   event: notify  -> "you have a new notification" (sent only to the people concerned)
// Everything is then fetched through the normal, permission-checked API, so the stream can
// never leak anything.

const clients = new Set();

function send(client, type) {
  try {
    client.res.write(`event: ${type}\ndata: {}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function addClient(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer this response
  });
  res.write('retry: 3000\n\n');

  const client = { res, userId: user ? user.id : null };
  clients.add(client);
  send(client, 'hello');
  req.on('close', () => clients.delete(client));
}

// Something changed: every connected browser (signed in or not) refreshes its view.
function broadcastData() {
  for (const client of clients) send(client, 'data');
}

// Tell specific people they have a notification.
function notifyUsers(userIds) {
  const wanted = new Set(userIds);
  for (const client of clients) {
    if (client.userId !== null && wanted.has(client.userId)) send(client, 'notify');
  }
}

// Proxies and load balancers close idle connections; a comment line every 25s keeps them open.
const heartbeat = setInterval(() => {
  for (const client of clients) {
    try { client.res.write(': ping\n\n'); } catch { clients.delete(client); }
  }
}, 25000);
heartbeat.unref();

function closeAll() {
  for (const client of clients) {
    try { client.res.end(); } catch { /* already gone */ }
  }
  clients.clear();
}

const connectionCount = () => clients.size;

module.exports = { addClient, broadcastData, notifyUsers, closeAll, connectionCount };
