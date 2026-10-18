# SRE Alert Tracking Dashboard with Timeline Events

![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)
![Status](https://img.shields.io/badge/status-internal%20tool-blue)
![License](https://img.shields.io/badge/license-proprietary%20%2F%20internal%20use-lightgrey)

An internal tool for SRE on-call shifts: track alerts, who owns them, their status, and a
timeline of events (issue occurred, identified, RCA, completion, or any label you invent) so
the next shift can pick up exactly where the last one left off.

Zero npm dependencies: Node's built-in `http` and `node:sqlite` (Node 22.5+). Deploying is
"copy the folder, run it."

> [!WARNING]
> **Internal tool, no built-in network protection.** There is no SSO and no email verification
> — accounts are created by a super user from inside the app. Anyone who can reach the server
> can view everything, and once signed in, create and work on alerts. Run this only on a
> private network (VPN / office LAN / a locked-down security group), never exposed to the
> public internet without adding your own access control in front of it.

> [!NOTE]
> This repository is for internal use. See [License](#license) before sharing it outside the
> team or organization.

## Contents

- [Features](#features)
- [Who can do what](#who-can-do-what)
- [First run and sign-in](#first-run-and-sign-in)
- [Project layout](#project-layout)
- [Run it locally](#run-it-locally)
- [Deploying to EC2 (or any Linux box)](#deploying-to-ec2-or-any-linux-box)
- [Settings (environment variables)](#settings-environment-variables)
- [Backups](#backups)
- [Upgrading an existing install](#upgrading-an-existing-install)
- [Security notes](#security-notes)
- [Tests](#tests)
- [API reference](#api-reference)
- [Known constraints](#known-constraints)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Login and roles.** Anyone can *view* the dashboard and alerts, read-only. Only signed-in
  users can change things. Two roles: **User** and **Super user** (manages accounts, imports
  backups, can export everything).
- **Severity levels:** **Show-stopper, Critical, High, Error** (most to least severe).
- **Links.** Any number of named links on every alert and every timeline event — dashboards,
  runbooks, tickets. Each opens in a new tab. Only `http(s)` URLs are accepted.
- **Who can continue an alert**, chosen when it's created and changeable later by the creator
  or a super user:
  - **Assigned with take care** *(default)*. **Take care is shared**: any number of people
    signed in can press it, which lets them **add timeline events and nothing else** — it
    never assigns them and nobody is asked to assign anything. **Assigning is exclusive**: once
    somebody is assigned (themselves, via "Assign to me", or by the creator/super user), only
    that person, the creator, or a super user can change the assignment or the status. People
    who are just taking care can still add events even while it's assigned.
  - **Assigned to anyone**: the creator, the assignee, or a super user can assign it to any
    teammate. Anyone signed in can assign an *unassigned* alert to themselves. No "take care."
  - **Only me**: only the creator and super users work on it. Nobody else can be assigned or
    take care of it.
- **Notification bell** (top right). Creating an alert as *Assigned with take care* notifies
  every other user, so someone can pick it up. The bell shows an unread count and a toast when
  a new one arrives; clicking a notification opens the alert and marks it read.
- **My alerts.** Every alert list (reached from Total alerts, Ongoing, Monitoring, On Hold or
  Completed on the dashboard) has a **My alerts** button for signed-in users, showing two
  groups: **Assigned to me** and **Taking care**.
- **Live updates.** Changes appear on everybody's screen as they happen, no refresh needed:
  new alerts, status changes, assignments, timeline entries, notifications. Visitors who
  aren't signed in see them too. (Falls back to catching up within a minute if the live
  connection is blocked by a proxy — see [deploying with nginx](#deploying-to-ec2-or-any-linux-box).)
- **Timeline.** Events are ordered by the time you say they happened, so you can backfill an
  earlier entry and it slots into place — there's no manual reordering. Between the events the
  timeline shows automatic grey comments: who created / assigned / took care of / stopped
  taking care of / unassigned the alert, status changes, and automatic On Hold.
- **Statuses.** *Ongoing*, *Monitoring*, *On Hold* and *Completed* can all be set by hand.
  **On Hold is also applied automatically**: an *Ongoing* alert with no timeline update (an
  event added or edited) for **3 days** goes On Hold by itself. An automatic hold lifts itself
  the moment someone adds an update; **a hold set by hand stays until a person changes it.**
  Monitoring is never set automatically. Changing the status by hand restarts the 3-day clock.
- **Dashboard.** Status cards → *Alerts by status* (donut) and *Alerts over time* (7/14/30
  days) → active alerts grouped by severity → team workload (created vs. working on now).
  Everything on it drills into the matching alert list.
- **Backup.** Export alerts & events, users, or all data as JSON. Import with *Merge* (safe,
  skips anything that already exists) or *Replace* (disaster recovery). Backups exported by an
  earlier version of this tool still import (old severity names and the old "open" mode are
  translated automatically).

## Who can do what

| Action | Anonymous | Signed-in user | Alert creator | Assignee | Taking care | Super user |
|---|---|---|---|---|---|---|
| View dashboard, alerts, timelines, links | yes | yes | yes | yes | yes | yes |
| Create an alert | no | yes | yes | yes | yes | yes |
| **Add** timeline events | no | no | yes | yes (not "Only me") | **yes** | yes |
| Edit/delete timeline events, edit the alert, change severity/links | no | no | yes | yes (not "Only me") | no | yes |
| Change status | no | no | yes | yes (not "Only me") | no | yes |
| Assign / unassign / hand over | no | no | yes | yes (not "Only me") | no | yes |
| Take care (shared — any number of people) | no | yes ("take care" mode, not completed) | n/a (can already add events) | n/a | can stop any time | n/a |
| Assign an unassigned alert to yourself | no | yes ("anyone" mode, or a take-care alert created with "Nobody yet"; not completed) | yes | n/a | yes (same alerts) | yes |
| Change who can continue the alert (its mode) | no | no | yes | no | no | yes |
| Delete an alert | no | no | yes | no | no | yes |
| Manage users, import backups, export users/all | no | no | no | no | no | yes |

People taking care lose the ability to add events once the alert is *Completed*, or if its
mode is changed away from *Assigned with take care* (they get it back if it's switched back).
"Only me" alerts can't be assigned by anyone — super users included — until the mode is changed.

## First run and sign-in

On the first start, with an empty user table, the app creates one super user:

- username **`admin`** (override with the `ADMIN_USERNAME` environment variable)
- password **`admin123`** (override with `ADMIN_PASSWORD`)

The default password is flagged: right after signing in you're asked to change it (you can
dismiss the prompt, but a banner stays until you do). Accounts created from **Manage users**,
and passwords reset there, are flagged the same way.

> [!CAUTION]
> `admin123` is public knowledge — it's printed in this README. Set `ADMIN_PASSWORD` before
> the first start if this will be reachable by more than a couple of trusted people, and
> restrict network access regardless.

**Already have a database with an admin password you don't know?** The default only applies
to a brand-new database. To reset an existing account, run the recovery command — the same way
you run the server (with `sudo` if the server runs with `sudo`):

```bash
cd ~/sre-dashboard
sudo node scripts/reset-password.js admin              # sets the password to admin123
sudo node scripts/reset-password.js admin 'NewPass-123' # or choose one
sudo node scripts/reset-password.js rescue 'NewPass-123' --create   # make a new super user
```

Safe to run while the server is up. The user is signed out everywhere and asked to change
the password at their next sign-in.

## Project layout

```
sre-dashboard/
├── server.js              # HTTP server, routes, auth/permission enforcement, startup
├── lib/
│   ├── config.js          # statuses, severities, modes, limits — single source of truth
│   ├── db.js              # SQLite connection + versioned migrations
│   ├── store.js           # all database queries (incidents, events, users, notifications…)
│   ├── permissions.js     # pure functions: who can do what to a given alert
│   ├── auth.js            # password hashing, sessions, cookies, login throttling
│   ├── backup.js          # export / import (validated, transactional)
│   ├── realtime.js        # server-sent-events hub for live updates
│   ├── router.js          # tiny HTTP router
│   ├── validation.js      # input validation helpers
│   └── errors.js          # typed HTTP errors
├── public/                # static frontend: vanilla JS modules, no build step
│   ├── index.html, styles.css
│   └── js/ (api.js, ui.js, charts.js, links.js, realtime.js, notifications.js, main.js, views/)
├── scripts/
│   └── reset-password.js  # offline password-recovery CLI
├── data/                  # SQLite file lives here at runtime (not checked in)
├── deploy/
│   ├── sre-dashboard.service     # systemd unit (binds :80 without running as root)
│   └── nginx.conf.example        # optional reverse proxy (TLS, hostname)
└── test/                  # API, permissions, migrations, backup, realtime, frontend unit tests
```

## Run it locally

Requires **Node.js 22.5 or newer** (for the built-in `node:sqlite`).

```bash
git clone https://github.com/Anbarasu-A-N/sre-dashboard.git
cd sre-dashboard
npm start
# SRE dashboard listening on http://0.0.0.0:3000
# Or
sudo PORT=80 node server.js
# SRE dashboard listening on http://0.0.0.0:80
```

Open `http://localhost:3000`. No build step, no `npm install` — there's nothing in
`node_modules` to install.

## Deploying to EC2 (or any Linux box)

1. **Install Node 22.5+** (Ubuntu example):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **Copy the project** to the box, e.g. to `/opt/sre-dashboard`, owned by the user that will
   run it.
3. **Optional settings** before the first start (see the table below) go in
   `/etc/sre-dashboard/env`:
   ```bash
   sudo mkdir -p /etc/sre-dashboard
   echo 'ADMIN_PASSWORD=pick-something-strong' | sudo tee /etc/sre-dashboard/env
   sudo chmod 600 /etc/sre-dashboard/env
   ```
4. **Run it as a systemd service** (restarts on crash/reboot, binds port 80 without root via
   `AmbientCapabilities`):
   ```bash
   sudo cp /opt/sre-dashboard/deploy/sre-dashboard.service /etc/systemd/system/
   # edit User/Group/WorkingDirectory in that file if your path/user differ
   sudo systemctl daemon-reload
   sudo systemctl enable --now sre-dashboard
   sudo systemctl status sre-dashboard
   journalctl -u sre-dashboard | grep -A4 "First run"   # see the generated/default password
   ```
5. **Restrict network access.** In the EC2 security group, allow inbound only from your
   VPN/office CIDR — never `0.0.0.0/0`. This is an internal tool with no additional access
   control of its own.
6. **Optional: nginx**, if you want TLS or a hostname instead of `http://<ip>`. Run the app on
   port 3000 (`PORT=3000` in the systemd unit) and set `TRUST_PROXY=1` (so login throttling sees
   real client IPs) and, once on HTTPS, `COOKIE_SECURE=1`. Use `deploy/nginx.conf.example`,
   which includes the `/api/stream` block live updates need (without it they still catch up
   within a minute, just not instantly).

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | Listen address |
| `DATA_DIR` | `./data` | Where `dashboard.db` lives |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / admin123 | First-run super user only |
| `SESSION_HOURS` | 168 | Sign-in lifetime |
| `AUTO_HOLD_DAYS` | 3 | Days without a timeline update before an Ongoing alert goes On Hold |
| `TRUST_PROXY` | off | Trust `X-Forwarded-*` from nginx/a load balancer |
| `COOKIE_SECURE` | off | Mark the session cookie HTTPS-only |
| `QUIET` | off | Suppress per-request access logging |

## Backups

- **In the app:** user menu → **Backup & export**. *All data* is the full backup. Files that
  include users contain password hashes — store them like a password vault.
- **Import:** *Merge* never overwrites existing alerts or users. *Replace* wipes the
  categories present in the file and restores it exactly (alert IDs kept); replacing users
  signs everyone out and refuses a file with no super user in it.
- **At the filesystem level**, everything is `data/dashboard.db` (plus `-wal`/`-shm` while
  running):
  ```bash
  sqlite3 data/dashboard.db ".backup /opt/backups/dashboard-$(date +%F).db"
  ```

## Upgrading an existing install

1. **Back up first:** `cp data/dashboard.db data/dashboard.db.bak`
2. Stop the service, copy the new files over (keep `data/`), start it again.
3. The database upgrades itself automatically — this is covered by tests against every
   previous schema version. Existing alerts, users, timelines and links are kept, and old
   severity names / modes are translated. Alerts that already exist keep behaving exactly as
   they did before; new rules only apply to alerts created from now on.
4. If running under systemd: `sudo systemctl daemon-reload && sudo systemctl restart sre-dashboard`
5. If using nginx: add the `/api/stream` block from `deploy/nginx.conf.example` so live
   updates aren't buffered.

## Security notes

Passwords are hashed with scrypt. Session tokens are random, and only their SHA-256 hash is
stored, so a leaked database holds no usable sessions. Cookies are `HttpOnly` + `SameSite=Lax`.
Cross-origin writes are rejected. Failed logins are throttled per IP (10 per 15 minutes). All
rendering is auto-escaped and a strict Content-Security-Policy is sent. Link URLs are limited
to `http(s)`. The live-update stream carries only empty "something changed" pings — never
alert content — and everything is then fetched through the normal, permission-checked API.

There is **no SSO, no email verification, and no built-in rate limiting beyond login attempts**.
This tool is designed to sit behind your own network perimeter (see
[deploying to EC2](#deploying-to-ec2-or-any-linux-box)), not to be exposed directly to the
public internet.

## Tests

```bash
npm test                 # API, permissions, take care / assign rules, notifications,
                          # live updates, On Hold, every schema migration, backup, CLI, charts
                          # — no external dependencies
python3 test/e2e.py      # optional real-browser run: pip install playwright && playwright install chromium
```

## API reference

JSON over HTTP, session via cookie.

| Method | Path | Who |
|---|---|---|
| GET | `/api/meta` | anyone |
| GET | `/api/dashboard?days=&tz=` | anyone |
| GET | `/api/incidents?status=&severity=&assignee=&created_by=&active=1&q=&mine=1` (`mine` needs sign-in) | anyone |
| GET | `/api/incidents/:id` (includes your `permissions`, `events`, `activity`, `carers`) | anyone |
| POST | `/api/incidents` | signed in |
| PATCH / DELETE | `/api/incidents/:id` | per the table above |
| POST | `/api/incidents/:id/assign` `{assignee}` (`""` unassigns; your own name assigns you) | per the table above |
| POST / DELETE | `/api/incidents/:id/care` (start / stop taking care; `DELETE ...?user=name` removes someone else) | signed in; removing others: creator / assignee / super user |
| POST | `/api/incidents/:id/events` | creator / assignee / super user / anyone taking care |
| PATCH / DELETE | `/api/events/:id` | creator / assignee / super user |
| GET | `/api/auth/me` | anyone |
| POST | `/api/auth/login`, `/api/auth/logout` | anyone |
| POST | `/api/auth/password` | signed in |
| GET | `/api/users/directory` | signed in |
| GET/POST/PATCH/DELETE | `/api/users`, `/api/users/:id` | super user |
| GET | `/api/notifications` | signed in |
| POST | `/api/notifications/read` `{ids:[...]}` or `{all:true}` | signed in |
| GET | `/api/stream` (live "something changed" pings, server-sent events) | anyone |
| GET | `/api/export?scope=events` | signed in |
| GET | `/api/export?scope=users\|all` | super user |
| POST | `/api/import?mode=merge\|replace` | super user |
| GET | `/healthz` | anyone |

## Known constraints

- **Single SQLite file.** This fits one server comfortably; it is not built for running
  multiple app instances behind a load balancer (SQLite is single-writer, and in-memory state
  — live connections, login throttling — is per-process). If that's ever needed, `lib/store.js`
  is the only file that talks to the database, so swapping it for Postgres is a contained
  change rather than a rewrite.
- **No SSO/email.** Accounts are created and managed entirely by super users inside the app.

## Contributing

This is a small internal codebase, kept deliberately dependency-free. Before opening a PR:

1. Run `npm test` — it covers the API, permission rules, every schema migration, backup
   import/export, live updates, and the frontend's pure logic. It must stay green.
2. If you touch `public/js/`, also run the browser check: `python3 test/e2e.py` (needs
   `pip install playwright && playwright install chromium`).
3. Keep the zero-dependency constraint unless there's a strong reason not to — it's what makes
   deployment "copy the folder, run it." `lib/config.js` is the place for new statuses,
   severities, or limits; `lib/store.js` is the only file that talks to the database.
4. Database schema changes go in `lib/db.js` as a new, additive migration — never edit an
   existing one — and need a test that upgrades a planted copy of the previous schema (see
   `test/migration-v*.test.js` for the pattern).

## License

Proprietary — internal use only. Not licensed for redistribution or use outside the team or
organization that owns this repository. Remove or replace this section if that changes.