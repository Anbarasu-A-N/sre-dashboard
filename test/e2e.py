# Optional end-to-end browser test. Needs: pip install playwright && playwright install chromium
# Run: python3 test/e2e.py   (starts its own server on a temp database; screenshots land in the temp dir)
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(tempfile.gettempdir(), "sre-dashboard-shots")
PORT = 3100
BASE = f"http://127.0.0.1:{PORT}"
ADMIN_PW = "AdminPass123"

shutil.rmtree(SHOTS, ignore_errors=True)
os.makedirs(SHOTS)
data_dir = tempfile.mkdtemp(prefix="e2e-data-")

env = dict(os.environ, DATA_DIR=data_dir, PORT=str(PORT), ADMIN_PASSWORD=ADMIN_PW, QUIET="1")
server = subprocess.Popen(["node", "--disable-warning=ExperimentalWarning", "server.js"], cwd=ROOT, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

def wait_ready():
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/healthz", timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")

problems = []
steps = []

def step(name):
    steps.append(name)
    print(f"  - {name}", flush=True)

def shot(page, name):
    page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)

try:
    wait_ready()
    with sync_playwright() as p:
        browser = p.chromium.launch()

        def new_context(**kw):
            ctx = browser.new_context(accept_downloads=True, **kw)
            # No internet in the sandbox: answer any external host with a stub page so we can
            # verify where a link really navigates.
            ctx.route(lambda url: "127.0.0.1" not in url,
                      lambda route: route.fulfill(status=200, content_type="text/html", body="<h1>external stub</h1>"))
            return ctx

        def watch(page, who):
            page.on("pageerror", lambda e: problems.append(f"[{who}] pageerror: {e}"))
            page.on("console", lambda m: problems.append(f"[{who}] console.{m.type}: {m.text}") if m.type in ("error",) and "Failed to load resource" not in m.text else None)

        # ---------- helpers ----------
        def sign_in(page, user, pw, dismiss_nag=True):
            page.get_by_role("button", name="Sign in").first.click()
            dlg = page.locator("dialog[open]")
            dlg.get_by_label("Username").fill(user)
            dlg.get_by_label("Password").fill(pw)
            dlg.get_by_role("button", name="Sign in").click()
            expect(page.locator(".user-menu__btn")).to_be_visible()
            if dismiss_nag:
                # accounts with a temporary password are asked to change it straight away; skip that here
                try:
                    page.locator("dialog[open]").wait_for(timeout=1200)
                    page.locator("dialog[open]").get_by_role("button", name="Cancel").click()
                except Exception:
                    pass
                expect(page.locator("dialog[open]")).to_have_count(0)

        def ensure_signed_in(page, user, pw):
            if page.locator("#topbarActions").get_by_role("button", name="Sign in").count():
                sign_in(page, user, pw)

        def sign_out(page):
            page.locator(".user-menu__btn").click()
            page.get_by_role("button", name="Sign out").click()
            expect(page.locator("#topbarActions").get_by_role("button", name="Sign in")).to_be_visible()

        def new_alert(page, title, severity="High", mode=None, assign_label=None, links=(), desc=""):
            page.get_by_role("button", name="New alert").click()
            dlg = page.locator("dialog[open]")
            dlg.get_by_label("Title").fill(title)
            if desc:
                dlg.get_by_label("Description").fill(desc)
            dlg.get_by_label("Severity").select_option(severity)
            if mode == "private":
                dlg.get_by_text("Only me", exact=True).click()
                expect(dlg.get_by_label("Assign to", exact=True)).to_be_hidden()
            elif mode == "anyone":
                dlg.get_by_text("Assigned to anyone", exact=True).click()
            if assign_label and mode != "private":
                dlg.get_by_label("Assign to", exact=True).select_option(label=assign_label)
            for name, url in links:
                dlg.get_by_role("button", name="+ Add link").click()
                row = dlg.locator(".link-row").last
                row.locator(".link-row__name").fill(name)
                row.locator(".link-row__url").fill(url)
            dlg.get_by_role("button", name="Create alert").click()
            expect(page.locator(".incident-head h2")).to_contain_text(title)

        # =====================================================================
        step("anonymous visitor sees a read-only dashboard")
        anon_ctx = new_context(viewport={"width": 1280, "height": 900})
        anon = anon_ctx.new_page(); watch(anon, "anon")
        anon.goto(BASE)
        expect(anon.locator("#banner")).to_be_visible()
        expect(anon.locator("#banner")).to_contain_text("read-only")
        expect(anon.get_by_role("button", name="New alert")).to_have_count(0)
        expect(anon.locator(".stat-tile")).to_have_count(5)
        expect(anon.locator(".sev-group")).to_have_count(4)
        expect(anon.locator(".sev-group .sev-tag")).to_have_text(["Show-stopper", "Critical", "High", "Error"])
        expect(anon.locator("svg.donut")).to_be_visible()
        shot(anon, "01-anon-empty-dashboard")

        step("wrong password shows an inline error, right password signs in")
        anon.get_by_role("button", name="Sign in").first.click()
        dlg = anon.locator("dialog[open]")
        dlg.get_by_label("Username").fill("admin")
        dlg.get_by_label("Password").fill("totally-wrong")
        dlg.get_by_role("button", name="Sign in").click()
        expect(dlg.locator(".form-error")).to_contain_text("Incorrect username or password")
        dlg.get_by_label("Password").fill(ADMIN_PW)
        dlg.get_by_role("button", name="Sign in").click()
        expect(anon.locator(".user-menu__btn")).to_contain_text("admin")
        expect(anon.locator(".user-menu__btn")).to_contain_text("Super user")
        expect(anon.locator("#banner")).to_be_hidden()

        step("super user creates three users; they are marked as having temporary passwords")
        anon.locator(".user-menu__btn").click()
        anon.get_by_role("link", name="Manage users").click()
        for name in ("alice", "bob", "carol"):
            anon.get_by_role("button", name="+ Add user").click()
            d = anon.locator("dialog[open]")
            d.get_by_label("Username").fill(name)
            d.get_by_label("Temporary password").fill(f"{name}-password-1")
            d.get_by_role("button", name="Create user").click()
            expect(anon.locator("tbody tr", has_text=name)).to_be_visible()
        # duplicate is rejected inline
        anon.get_by_role("button", name="+ Add user").click()
        d = anon.locator("dialog[open]")
        d.get_by_label("Username").fill("alice")
        d.get_by_label("Temporary password").fill("alice-password-1")
        d.get_by_role("button", name="Create user").click()
        expect(d.locator(".form-error")).to_contain_text("already taken")
        d.get_by_role("button", name="Cancel").click()
        expect(anon.locator("tbody tr", has_text="carol").locator(".tag", has_text="Temporary password")).to_be_visible()
        expect(anon.locator("tbody tr", has_text="admin").locator(".tag", has_text="Temporary password")).to_have_count(0)
        shot(anon, "02-users-page")
        sign_out(anon)

        # =====================================================================
        alice_ctx = new_context(viewport={"width": 1280, "height": 900})
        alice = alice_ctx.new_page(); watch(alice, "alice")
        alice.goto(BASE)
        step("a user with a temporary password is asked to change it (and can dismiss that)")
        sign_in(alice, "alice", "alice-password-1", dismiss_nag=False)
        nag = alice.locator("dialog[open]")
        expect(nag.get_by_role("heading", name="Change password")).to_be_visible()
        nag.get_by_role("button", name="Cancel").click()
        expect(alice.locator("#pwBanner")).to_be_visible()
        expect(alice.locator("#pwBanner")).to_contain_text("temporary or default password")
        alice.get_by_role("button", name="New alert").click()
        d = alice.locator("dialog[open]")
        expect(d.get_by_label("Assigned with take care (default)")).to_be_checked()   # default mode
        expect(d.get_by_text("Assigned to anyone", exact=True)).to_be_visible()
        expect(d.get_by_text("Only me", exact=True)).to_be_visible()
        expect(d.get_by_text("Continue with others")).to_have_count(0)                # old name is gone
        d.get_by_role("button", name="Cancel").click()

        step("alice creates an alert with several named links")
        new_alert(alice, "Payment API 5xx spike", severity="Show-stopper", desc="Checkout returning 502s for ~8% of requests",
                  links=[("Grafana", "https://grafana.example.com/d/payments"), ("Runbook", "wiki.example.com/runbooks/5xx"), ("Ticket OPS-42", "https://jira.example.com/browse/OPS-42")])
        chips = alice.locator(".incident-head .link-chip")
        expect(chips).to_have_count(3)
        expect(chips.nth(0)).to_contain_text("Grafana")
        expect(chips.nth(1)).to_have_attribute("href", "https://wiki.example.com/runbooks/5xx")
        for i in range(3):
            expect(chips.nth(i)).to_have_attribute("target", "_blank")
            expect(chips.nth(i)).to_have_attribute("rel", "noopener noreferrer")
        expect(alice.locator(".assign")).to_contain_text("Assigned to alice")

        step("clicking a link opens it in a NEW tab and leaves the dashboard open")
        with alice_ctx.expect_page() as popup_info:
            chips.nth(0).click()
        popup = popup_info.value
        assert "grafana.example.com" in popup.url, popup.url
        popup.close()
        expect(alice.locator(".incident-head h2")).to_contain_text("Payment API 5xx spike")

        step("javascript: links are refused by the dialog")
        alice.get_by_role("button", name="Edit", exact=True).first.click()
        d = alice.locator("dialog[open]")
        d.get_by_role("button", name="+ Add link").click()
        row = d.locator(".link-row").last
        row.locator(".link-row__name").fill("evil")
        row.locator(".link-row__url").fill("javascript:alert(1)")
        d.get_by_role("button", name="Save changes").click()
        expect(d.locator(".form-error")).to_contain_text("http")
        d.get_by_role("button", name="Cancel").click()

        step("timeline: preset chips, custom label, per-event links, edit")
        def add_event(label_preset=None, custom=None, note="", links=()):
            alice.get_by_role("button", name="+ Add event").click()
            d = alice.locator("dialog[open]")
            if label_preset:
                d.get_by_role("button", name=label_preset, exact=True).click()
                expect(d.get_by_label("Label")).to_have_value(label_preset)
            if custom:
                d.get_by_label("Label").fill(custom)
            if note:
                d.get_by_label("Notes").fill(note)
            for name, url in links:
                d.get_by_role("button", name="+ Add link").click()
                r = d.locator(".link-row").last
                r.locator(".link-row__name").fill(name)
                r.locator(".link-row__url").fill(url)
            d.get_by_role("button", name="Add event").click()
            expect(d).to_have_count(0)

        add_event("Issue Occurred", note="p99 latency crossed 2s", links=[("Latency graph", "https://grafana.example.com/d/lat")])
        add_event("Identified", note="Bad deploy suspected", links=[("PR #812", "https://git.example.com/pr/812"), ("Deploy log", "https://ci.example.com/job/99")])
        add_event(custom="Mitigation started", note="Rolling back")
        add_event("RCA", note="Config flag defaulted to off")
        add_event("Completion", note="Rollback verified, error rate normal")
        events = alice.locator(".timeline-item:not(.timeline-item--activity)")
        expect(events).to_have_count(5)
        expect(events.filter(has_text="Identified").locator(".link-chip")).to_have_count(2)
        expect(events.filter(has_text="Issue Occurred").locator(".link-chip")).to_have_count(1)
        expect(events.filter(has_text="Mitigation started")).to_have_count(1)

        step("automatic comments sit in the timeline: 'alice created this alert...'")
        created_row = alice.locator(".timeline-item--activity", has_text="alice created this alert and is taking care of it")
        expect(created_row).to_have_count(1)
        expect(created_row.locator(".activity__time")).to_be_visible()

        step("the timeline is chronological: a backfilled earlier event slots in at the top")
        alice.get_by_role("button", name="+ Add event").click()
        d = alice.locator("dialog[open]")
        d.get_by_label("Label").fill("Backfilled first sign")
        two_hours_ago = alice.evaluate("""() => { const d = new Date(Date.now() - 2*3600*1000); const p = (n) => String(n).padStart(2,'0');
            return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }""")
        d.get_by_label("Time it happened").fill(two_hours_ago)
        d.get_by_role("button", name="Add event").click()
        expect(alice.locator(".timeline-item").first.locator(".timeline-item__label")).to_have_text("Backfilled first sign")
        alice.reload()
        expect(alice.locator(".timeline-item").first.locator(".timeline-item__label")).to_have_text("Backfilled first sign")

        step("there is no drag-and-drop and no manual reordering any more")
        expect(alice.locator("[draggable='true']")).to_have_count(0)
        expect(alice.locator(".timeline-item__grip")).to_have_count(0)
        expect(alice.locator("[data-move]")).to_have_count(0)
        expect(alice.get_by_text("Drag")).to_have_count(0)
        shot(alice, "03-detail-timeline")

        step("editing and deleting a timeline event")
        alice.locator(".timeline-item", has_text="Mitigation started").get_by_role("button", name="Edit").click()
        d = alice.locator("dialog[open]")
        d.get_by_label("Notes").fill("Rolling back to v2.14")
        d.get_by_role("button", name="Save changes").click()
        expect(alice.locator(".timeline-item", has_text="Mitigation started")).to_contain_text("v2.14")
        alice.locator(".timeline-item", has_text="Mitigation started").get_by_role("button", name="Edit").click()
        d = alice.locator("dialog[open]")
        d.get_by_role("button", name="Delete", exact=True).click()
        confirm = alice.locator("dialog[open]").last
        confirm.get_by_role("button", name="Delete").click()
        expect(alice.locator(".timeline-item", has_text="Mitigation started")).to_have_count(0)

        step("alice creates an UNASSIGNED alert and a PRIVATE alert")
        alice.goto(BASE + "/#")
        new_alert(alice, "DB replica lag", severity="Critical", assign_label="Nobody yet (anyone can pick it up)")
        expect(alice.locator(".assign")).to_contain_text("Unassigned")
        alice.goto(BASE + "/#")
        new_alert(alice, "Investigating weird cert warning", severity="Error", mode="private")
        expect(alice.locator(".incident-head .tag", has_text="Only me")).to_be_visible()
        shot(alice, "04-private-alert-owner-view")
        sign_out(alice)

        # =====================================================================
        step("the bell: bob was notified about alice's two 'Assigned with take care' alerts (not the private one)")
        bob_ctx = new_context(viewport={"width": 1280, "height": 900})
        bob = bob_ctx.new_page(); watch(bob, "bob")
        bob.goto(BASE)
        sign_in(bob, "bob", "bob-password-1")
        expect(bob.locator("#notifBadge")).to_have_text("2")
        bob.locator("#notifBtn").click()
        panel = bob.locator("#notifPanel")
        expect(panel.locator(".notif__item")).to_have_count(2)
        expect(panel.locator(".notif__item.is-unread")).to_have_count(2)
        expect(panel).to_contain_text('alice created "DB replica lag" (Critical). Nobody is assigned yet: assign it to yourself or take care of it.')
        expect(panel).to_contain_text('alice created "Payment API 5xx spike" (Show-stopper). Anyone can take care of it.')
        expect(panel).not_to_contain_text("weird cert warning")                    # "Only me" alerts notify nobody
        shot(bob, "05a-notification-bell")
        panel.locator(".notif__item", has_text="DB replica lag").click()           # opens the alert and marks it read
        expect(bob.locator(".incident-head h2")).to_contain_text("DB replica lag")
        expect(bob.locator("#notifBadge")).to_have_text("1")
        expect(bob.locator("#notifPanel")).to_be_hidden()
        bob.locator("#notifBtn").click()
        bob.get_by_role("button", name="Mark all as read").click()
        expect(bob.locator("#notifBadge")).to_be_hidden()
        bob.keyboard.press("Escape")
        expect(bob.locator("#notifPanel")).to_be_hidden()

        step("an alert created with 'Nobody yet' offers both 'Assign to me' and 'Take care'")
        expect(bob.get_by_role("button", name="+ Add event")).to_have_count(0)      # not yet
        expect(bob.locator(".notice")).to_contain_text("Nobody is assigned yet")
        expect(bob.locator(".notice")).to_contain_text("Several people can take care at once")
        expect(bob.locator(".care").get_by_role("button", name="Assign to me")).to_be_visible()
        expect(bob.locator(".care").get_by_role("button", name="Take care", exact=True)).to_be_visible()
        shot(bob, "05-free-alert-both-options")

        step("Take care: bob can add events only; he is not assigned, and Assign to me stays available")
        bob.get_by_role("button", name="Take care", exact=True).click()
        expect(bob.locator(".care")).to_contain_text("Taking care: bob")
        expect(bob.locator(".assign")).to_contain_text("Unassigned")                # still nobody assigned
        expect(bob.get_by_role("button", name="Stop taking care")).to_be_visible()
        expect(bob.locator(".care").get_by_role("button", name="Assign to me")).to_be_visible()
        expect(bob.get_by_role("button", name="Take care", exact=True)).to_have_count(0)
        expect(bob.get_by_role("button", name="+ Add event")).to_be_visible()
        expect(bob.locator("select[data-act=assign]")).to_have_count(0)             # never asked to assign others
        expect(bob.get_by_role("button", name="Edit", exact=True)).to_have_count(0)
        expect(bob.locator("#statusSelect")).to_have_count(0)
        expect(bob.locator(".timeline-item--activity", has_text="bob took care of this alert")).to_have_count(1)
        bob.get_by_role("button", name="+ Add event").click()
        d = bob.locator("dialog[open]")
        d.get_by_role("button", name="Issue Occurred", exact=True).click()
        d.get_by_label("Notes").fill("Replica 40s behind primary")
        d.get_by_role("button", name="Add event").click()
        expect(bob.locator(".timeline-item:not(.timeline-item--activity)")).to_have_count(1)
        expect(bob.locator(".timeline-item__by")).to_contain_text("bob")
        expect(bob.locator(".timeline-item__tools")).to_have_count(0)               # a carer cannot edit events, even their own
        rows = bob.locator(".timeline-item")
        expect(rows).to_have_count(3)
        expect(rows.nth(0)).to_contain_text("alice created this alert")
        expect(rows.nth(1)).to_contain_text("bob took care of this alert")
        expect(rows.nth(2)).to_contain_text("Issue Occurred")
        shot(bob, "05b-took-care-activity-in-timeline")

        step("on an alert assigned to alice, bob still just gets Take care (events only), nothing else")
        bob.goto(BASE + "/#alerts")
        bob.get_by_role("link", name="Payment API 5xx spike").click()
        expect(bob.locator(".notice")).to_contain_text("Assigned to alice")
        expect(bob.locator(".notice")).to_contain_text("Take care")
        expect(bob.get_by_role("button", name="Take care", exact=True)).to_be_visible()
        expect(bob.get_by_role("button", name="Assign to me")).to_have_count(0)
        expect(bob.get_by_role("button", name="+ Add event")).to_have_count(0)
        expect(bob.get_by_role("button", name="Edit", exact=True)).to_have_count(0)
        expect(bob.locator("#statusSelect")).to_have_count(0)
        expect(bob.locator(".incident-head .link-chip")).to_have_count(3)        # links still visible to everyone
        shot(bob, "06-readonly-until-take-care")

        step("bob sees the 'Only me' alert as private: no Take care, no edit")
        bob.goto(BASE + "/#alerts")
        bob.get_by_role("link", name="Investigating weird cert warning").click()
        expect(bob.locator(".notice")).to_contain_text("private")
        expect(bob.get_by_role("button", name="Take care", exact=True)).to_have_count(0)
        expect(bob.get_by_role("button", name="Edit", exact=True)).to_have_count(0)

        step("bob creates an 'Assigned to anyone' alert for alice, then reassigns it to himself (creator)")
        bob.goto(BASE + "/#")
        new_alert(bob, "Disk filling on logging-3", severity="High", mode="anyone", assign_label="alice")
        expect(bob.locator(".assign")).to_contain_text("Assigned to alice")
        expect(bob.locator(".timeline-item--activity", has_text="bob created this alert, assigned to alice")).to_have_count(1)
        bob.locator("select[data-act=assign]").select_option(label="bob")
        expect(bob.locator(".assign")).to_contain_text("Assigned to bob")
        expect(bob.locator(".timeline-item--activity", has_text="bob assigned this alert to themselves (was alice)")).to_have_count(1)
        sign_out(bob)

        step("carol changes her temporary password from the prompt; the nag disappears")
        carol_ctx = new_context(viewport={"width": 1280, "height": 900})
        carol = carol_ctx.new_page(); watch(carol, "carol")
        carol.goto(BASE)
        sign_in(carol, "carol", "carol-password-1", dismiss_nag=False)
        d = carol.locator("dialog[open]")
        expect(d.get_by_role("heading", name="Change password")).to_be_visible()
        d.get_by_label("Current password").fill("carol-password-1")
        d.get_by_label("New password", exact=True).fill("carol-own-password-2")
        d.get_by_label("Confirm new password").fill("carol-own-password-2")
        d.get_by_role("button", name="Change password").click()
        expect(carol.locator("#pwBanner")).to_be_hidden()
        sign_out(carol)
        sign_in(carol, "carol", "carol-own-password-2")        # the new password works, no more prompt
        expect(carol.locator("#pwBanner")).to_be_hidden()

        step("in 'Assigned to anyone' mode carol cannot take over an assigned alert (no Take care button)")
        carol.goto(BASE + "/#alerts")
        carol.get_by_role("link", name="Disk filling on logging-3").click()
        expect(carol.get_by_role("button", name="Take care", exact=True)).to_have_count(0)
        expect(carol.get_by_role("button", name="Assign to me")).to_have_count(0)     # it is assigned already
        expect(carol.locator(".notice")).to_contain_text("Assigned to bob")
        expect(carol.locator(".notice")).to_contain_text("Only bob (the creator) or a super user can change the assignment or the status")
        expect(carol.get_by_role("button", name="+ Add event")).to_have_count(0)
        carol.goto(BASE + "/#alerts")
        carol.get_by_role("link", name="Payment API 5xx spike").click()
        expect(carol.get_by_role("button", name="Take care", exact=True)).to_be_visible()   # default mode: allowed

        step("an alert created WITH an assignee lets several people take care at once")
        carol.goto(BASE + "/#alerts")
        carol.get_by_role("link", name="Payment API 5xx spike").click()
        carol.get_by_role("button", name="Take care", exact=True).click()
        expect(carol.locator(".care")).to_contain_text("carol")
        expect(carol.get_by_role("button", name="+ Add event")).to_be_visible()
        expect(carol.get_by_role("button", name="Assign to me")).to_have_count(0)    # not a one-holder alert
        ensure_signed_in(bob, "bob", "bob-password-1")
        bob.goto(BASE + "/#alerts")
        bob.get_by_role("link", name="Payment API 5xx spike").click()
        bob.get_by_role("button", name="Take care", exact=True).click()
        expect(bob.locator(".care")).to_contain_text("carol")
        expect(bob.locator(".care")).to_contain_text("bob")
        expect(bob.get_by_role("button", name="+ Add event")).to_be_visible()
        expect(carol.locator(".care")).to_contain_text("bob")                        # carol's open page updated live

        step("ASSIGN is exclusive, TAKE CARE is shared: two screens, live")
        alice.goto(BASE)
        sign_in(alice, "alice", "alice-password-1")
        new_alert(alice, "Pickup probe", severity="Error", assign_label="Nobody yet (anyone can pick it up)")
        for page in (bob, carol):
            page.goto(BASE + "/#alerts")
            page.get_by_role("link", name="Pickup probe").click()
            expect(page.locator(".care").get_by_role("button", name="Assign to me")).to_be_visible()
            expect(page.locator(".care").get_by_role("button", name="Take care", exact=True)).to_be_visible()

        # --- Take care is shared
        bob.get_by_role("button", name="Take care", exact=True).click()
        expect(carol.locator(".care")).to_contain_text("Taking care: bob")                      # carol's page changed by itself
        expect(carol.locator(".care").get_by_role("button", name="Take care", exact=True)).to_be_visible()   # NOT blocked
        expect(carol.locator(".care").get_by_role("button", name="Assign to me")).to_be_visible()
        carol.locator(".care").get_by_role("button", name="Take care", exact=True).click()
        expect(bob.locator(".care")).to_contain_text("bob, carol")                              # both are taking care
        expect(carol.get_by_role("button", name="+ Add event")).to_be_visible()
        carol.get_by_role("button", name="+ Add event").click()
        d = carol.locator("dialog[open]")
        d.get_by_role("button", name="Update", exact=True).click()
        d.get_by_label("Notes").fill("carol is on it too")
        d.get_by_role("button", name="Add event").click()
        expect(bob.locator(".timeline-item:not(.timeline-item--activity)", has_text="carol is on it too")).to_have_count(1)
        shot(carol, "05c-two-people-taking-care")

        # --- Assign to me is exclusive, and locks assignment + status
        bob.locator(".care").get_by_role("button", name="Assign to me").click()
        expect(bob.locator(".assign")).to_contain_text("Assigned to bob")
        expect(bob.locator("button[data-act=edit]")).to_be_visible()                           # the assignee works on it fully
        expect(carol.locator(".assign")).to_contain_text("Assigned to bob")                   # live
        expect(carol.get_by_role("button", name="Assign to me")).to_have_count(0)
        expect(carol.locator("select[data-act=assign]")).to_have_count(0)
        expect(carol.get_by_role("button", name="Edit", exact=True)).to_have_count(0)
        expect(carol.locator("#statusSelect")).to_have_count(0)
        expect(carol.locator(".notice")).to_contain_text("Only bob, alice (the creator) or a super user can change the assignment or the status")
        # ...but carol is still taking care and can still add events; bob (now the assignee) is no longer listed as a carer
        expect(carol.get_by_role("button", name="+ Add event")).to_be_visible()
        expect(carol.get_by_role("button", name="Stop taking care")).to_be_visible()
        expect(carol.locator(".care")).to_contain_text("Taking care: carol")
        expect(carol.locator(".care")).not_to_contain_text("bob")
        shot(carol, "05d-locked-while-bob-is-assigned")
        # the creator can still change the status, and the lock holder's screen and carol's both follow
        alice.goto(BASE + "/#alerts")
        alice.get_by_role("link", name="Pickup probe").click()
        alice.locator("#statusSelect").select_option("Monitoring")
        expect(carol.locator(".status-pill--lg")).to_have_text("Monitoring")
        expect(bob.locator("#statusSelect")).to_have_value("Monitoring")
        # the assignee releases it: Assign to me is offered to everybody again
        bob.locator("select[data-act=assign]").select_option(label="Unassigned")
        expect(carol.locator(".care").get_by_role("button", name="Assign to me")).to_be_visible()
        # tidy up so the later counts are unchanged: the creator deletes the probe
        alice.locator("button[data-act=edit]").click()
        alice.locator("dialog[open]").get_by_role("button", name="Delete alert").click()
        alice.locator("dialog[open]").last.get_by_role("button", name="Delete alert").click()
        expect(bob.locator(".toast", has_text="This alert was deleted")).to_be_visible()
        sign_out(alice)

        # =====================================================================
        step("dashboard shows pie, bar charts, severity groups and workload")
        admin_ctx = new_context(viewport={"width": 1280, "height": 900})
        admin = admin_ctx.new_page(); watch(admin, "admin")
        admin.goto(BASE)
        sign_in(admin, "admin", ADMIN_PW)
        admin.goto(BASE + "/#")
        expect(admin.locator(".stat-tile").first.locator(".stat-tile__count")).to_have_text("4")
        expect(admin.locator(".donut__seg")).to_have_count(1)                     # all 4 are Ongoing
        expect(admin.locator(".donut__value")).to_have_text("4")
        expect(admin.locator(".bars__col")).to_have_count(14)
        expect(admin.locator(".sev-group").first).to_contain_text("Show-stopper")
        expect(admin.locator(".sev-group").first.locator(".sev-alert")).to_have_count(1)
        expect(admin.locator(".sev-group").first.locator(".sev-alert__who")).to_have_text("alice")
        wl = admin.locator(".wl-row")
        expect(wl.filter(has_text="alice")).to_have_count(1)
        expect(wl.filter(has_text="bob")).to_have_count(1)
        # alice created 3 (Payment, DB lag, private cert) and is working on 2 (Payment, private cert)
        expect(wl.filter(has_text="alice").locator(".wl-bar__val")).to_have_text(["3", "2"])
        # bob created 1 (Disk) and works on 1 (Disk). Taking care of DB lag does NOT make him its assignee.
        expect(wl.filter(has_text="bob").locator(".wl-bar__val")).to_have_text(["1", "1"])
        expect(wl.filter(has_text="Unassigned")).to_have_count(1)                  # DB replica lag has nobody assigned
        expect(wl.filter(has_text="Unassigned").locator(".wl-bar__val")).to_have_text(["1"])
        # layout order: status cards, then the two charts, then severity groups, then workload
        y = lambda sel: admin.locator(sel).first.bounding_box()["y"]
        assert y(".stats-grid") < y(".charts-row") < y(".sev-grid") < y(".wl"), "dashboard sections are in the wrong order"
        expect(admin.locator(".charts-row .panel__title")).to_have_text(["Alerts by status", "Alerts over time"])
        shot(admin, "07-dashboard-full")

        step("time range toggle re-renders the bar chart")
        admin.get_by_role("button", name="30d").click()
        expect(admin.locator(".bars__col")).to_have_count(30)
        admin.get_by_role("button", name="7d").click()
        expect(admin.locator(".bars__col")).to_have_count(7)
        admin.get_by_role("button", name="14d").click()
        expect(admin.locator(".bars__col")).to_have_count(14)

        step("LIVE UPDATES: a new alert appears on other people's screens without a refresh")
        live_anon_ctx = new_context(viewport={"width": 1280, "height": 900})
        live_anon = live_anon_ctx.new_page(); watch(live_anon, "live-anon")
        live_anon.goto(BASE + "/#alerts")
        expect(live_anon.locator("tbody tr")).to_have_count(4)
        unread_before = int(admin.locator("#notifBadge").inner_text())
        ensure_signed_in(bob, "bob", "bob-password-1")
        bob.goto(BASE + "/#")
        new_alert(bob, "Live update probe", severity="Error")                       # default mode: notifies everyone else
        # admin has NOT reloaded or clicked anything
        expect(admin.locator(".stat-tile").first.locator(".stat-tile__count")).to_have_text("5")
        expect(admin.locator(".stat-tile", has_text="Ongoing").locator(".stat-tile__count")).to_have_text("5")
        expect(admin.locator(".sev-group", has_text="Error")).to_contain_text("Live update probe")
        expect(live_anon.locator("tbody tr")).to_have_count(5)                       # a signed-out visitor sees it too
        expect(live_anon.locator("tbody")).to_contain_text("Live update probe")
        # the bell updates live, with a toast; the creator is not notified of their own alert
        expect(admin.locator("#notifBadge")).to_have_text(str(unread_before + 1))
        expect(admin.locator(".toast", has_text='bob created "Live update probe"')).to_be_visible()
        expect(bob.locator("#notifBadge")).to_be_hidden()
        shot(admin, "07b-live-dashboard-after-others-create")

        step("LIVE UPDATES: an alert you are looking at updates when someone else changes it, and when it is deleted")
        admin.goto(BASE + "/#alerts")
        admin.get_by_role("link", name="Live update probe").click()
        expect(admin.locator("#statusSelect")).to_have_value("Ongoing")
        bob.locator("#statusSelect").select_option("Monitoring")                     # bob changes it
        expect(admin.locator("#statusSelect")).to_have_value("Monitoring")           # admin sees it, untouched
        expect(admin.locator(".timeline-item--activity", has_text="bob changed the status from Ongoing to Monitoring")).to_have_count(1)
        bob.get_by_role("button", name="Edit", exact=True).click()                   # and bob deletes it
        bob.locator("dialog[open]").get_by_role("button", name="Delete alert").click()
        bob.locator("dialog[open]").last.get_by_role("button", name="Delete alert").click()
        expect(admin.locator(".toast", has_text="This alert was deleted")).to_be_visible()
        expect(live_anon.locator("tbody tr")).to_have_count(4)                       # gone from the visitor's list as well
        admin.goto(BASE + "/#")
        expect(admin.locator(".stat-tile").first.locator(".stat-tile__count")).to_have_text("4")

        step("MY ALERTS: the button is on every status card, and shows exactly two groups")
        bob.goto(BASE + "/#")
        bob.locator(".stat-tile", has_text="Ongoing").click()
        expect(bob.locator("#listTitle")).to_have_text("Ongoing alerts")
        expect(bob.locator("#mineBtn")).to_be_visible()
        expect(bob.locator("tbody tr")).to_have_count(4)                             # the full list first
        bob.locator("#mineBtn").click()
        expect(bob.locator("#listTitle")).to_have_text("My Ongoing alerts")
        groups = bob.locator(".mine-group")
        expect(groups).to_have_count(2)
        expect(groups.nth(0).locator(".section__title")).to_contain_text("Assigned to me")
        expect(groups.nth(0).locator(".section__title")).to_contain_text("(1)")
        expect(groups.nth(0)).to_contain_text("Disk filling on logging-3")
        expect(groups.nth(1).locator(".section__title")).to_contain_text("Taking care")
        expect(groups.nth(1).locator(".section__title")).to_contain_text("(2)")
        expect(groups.nth(1)).to_contain_text("DB replica lag")
        expect(groups.nth(1)).to_contain_text("Payment API 5xx spike")
        expect(bob.locator("tbody tr")).to_have_count(3)                             # nothing else is shown
        expect(bob.locator("#mineBtn")).to_have_attribute("aria-pressed", "true")
        shot(bob, "07c-my-alerts")
        for tile in ("Total alerts", "Monitoring", "On Hold", "Completed"):          # the button is on all five cards
            bob.goto(BASE + "/#")
            bob.locator(".stat-tile", has_text=tile).click()
            expect(bob.locator("#mineBtn")).to_be_visible()
        bob.goto(BASE + "/#alerts?status=Monitoring&mine=1")
        expect(bob.locator(".mine-group")).to_have_count(2)                          # empty groups explain themselves
        expect(bob.locator(".mine-group").first).to_contain_text("Nothing is assigned to you here")
        bob.goto(BASE + "/#alerts?status=Ongoing&mine=1")
        bob.locator("#mineBtn").click()                                              # toggling off returns the full list
        expect(bob.locator("#listTitle")).to_have_text("Ongoing alerts")
        expect(bob.locator("tbody tr")).to_have_count(4)
        live_anon.goto(BASE + "/#alerts?status=Ongoing")
        expect(live_anon.locator("#mineBtn")).to_have_count(0)                       # visitors do not get it

        step("stopping Take care removes the alert from 'Taking care'; taking care again brings it back")
        bob.goto(BASE + "/#alerts?status=Ongoing&mine=1")
        bob.get_by_role("link", name="DB replica lag").click()
        bob.get_by_role("button", name="Stop taking care").click()
        expect(bob.get_by_role("button", name="+ Add event")).to_have_count(0)
        expect(bob.locator(".care")).to_contain_text("Nobody is assigned or taking care")   # nobody left taking care
        expect(bob.locator(".care").get_by_role("button", name="Take care", exact=True)).to_be_visible()
        expect(bob.locator(".care").get_by_role("button", name="Assign to me")).to_be_visible()
        bob.go_back()
        expect(bob.locator(".mine-group").nth(1)).not_to_contain_text("DB replica lag")     # gone from "Taking care"
        expect(bob.locator(".mine-group").nth(1)).to_contain_text("Payment API 5xx spike")  # still caring for this one
        bob.get_by_role("link", name="Disk filling on logging-3").click()            # (still a normal alert)
        bob.go_back()
        bob.goto(BASE + "/#alerts?status=Ongoing")
        bob.get_by_role("link", name="DB replica lag").click()
        bob.get_by_role("button", name="Take care", exact=True).click()
        expect(bob.get_by_role("button", name="+ Add event")).to_be_visible()

        step("pie slice, legend, severity and workload bars all drill into the alert list")
        admin.locator(".donut__seg").first.click(position={"x": 72, "y": 2})   # on the ring itself (the hole is empty)
        expect(admin.locator("#listTitle")).to_have_text("Ongoing alerts")
        expect(admin.locator("tbody tr")).to_have_count(4)
        admin.go_back()
        admin.locator(".sev-group a.sev-tag").nth(2).click()                       # High
        expect(admin.locator("#listTitle")).to_have_text("High alerts")
        try:
            expect(admin.locator("tbody tr")).to_have_count(1)
        except AssertionError:
            print("DEBUG url:", admin.url); print("DEBUG rows:", admin.locator("tbody").inner_text()); raise
        admin.go_back()
        admin.locator(".wl-row", has_text="alice").locator("a[title^='Working on']").click()
        expect(admin.locator("#listTitle")).to_have_text("Active · Assigned to alice alerts")
        expect(admin.locator("tbody tr")).to_have_count(2)      # Payment + her private cert alert
        admin.get_by_role("link", name="Payment API 5xx spike").click()
        expect(admin.get_by_role("link", name="← Back")).to_have_attribute("href", "#alerts?assignee=alice&active=1")

        step("a super user can edit and reassign anybody's alert, including a private one")
        admin.goto(BASE + "/#alerts")
        admin.get_by_role("link", name="Investigating weird cert warning").click()
        expect(admin.get_by_role("button", name="+ Add event")).to_be_visible()
        expect(admin.locator("select[data-act=assign]")).to_have_count(0)           # private: must switch mode first
        admin.get_by_role("button", name="Edit", exact=True).click()
        d = admin.locator("dialog[open]")
        d.get_by_text("Assigned with take care", exact=False).first.click()
        d.get_by_role("button", name="Save changes").click()
        expect(admin.locator(".incident-head .tag", has_text="Only me")).to_have_count(0)
        expect(admin.locator(".timeline-item--activity", has_text='changed who can continue this alert to "Assigned with take care"')).to_have_count(1)
        admin.locator("select[data-act=assign]").select_option(label="bob")
        expect(admin.locator(".assign")).to_contain_text("Assigned to bob")

        step("status choices include On Hold; a hold set by hand stays until a person lifts it")
        opts = admin.locator("#statusSelect option").all_inner_texts()
        assert opts == ["Ongoing", "Monitoring", "On Hold", "Completed"], opts
        admin.locator("#statusSelect").select_option("Monitoring")                  # Monitoring is set by hand
        expect(admin.locator(".timeline-item--activity", has_text="admin changed the status from Ongoing to Monitoring")).to_have_count(1)
        admin.locator("#statusSelect").select_option("On Hold")                     # so is On Hold
        expect(admin.locator(".timeline-item--activity", has_text="admin changed the status from Monitoring to On Hold")).to_have_count(1)
        expect(admin.locator(".notice", has_text="On Hold")).to_contain_text("set by hand")
        admin.get_by_role("button", name="+ Add event").click()
        d = admin.locator("dialog[open]")
        d.get_by_role("button", name="Update", exact=True).click()
        d.get_by_label("Notes").fill("Waiting for the vendor")
        d.get_by_role("button", name="Add event").click()
        expect(admin.locator(".timeline-item:not(.timeline-item--activity)", has_text="Waiting for the vendor")).to_have_count(1)
        expect(admin.locator("#statusSelect")).to_have_value("On Hold")             # an update does NOT lift a manual hold
        expect(admin.locator(".timeline-item--activity", has_text="back to Ongoing")).to_have_count(0)
        admin.locator("#statusSelect").select_option("Ongoing")

        step("changing status updates the dashboard counts")
        admin.locator("#statusSelect").select_option("Completed")
        expect(admin.locator(".incident-head__meta")).to_contain_text("Closed")
        admin.goto(BASE + "/#")
        expect(admin.locator(".stat-tile", has_text="Completed").locator(".stat-tile__count")).to_have_text("1")
        expect(admin.locator(".donut__seg")).to_have_count(2)
        shot(admin, "08-dashboard-after-status-change")

        # =====================================================================
        step("an AUTOMATIC hold resumes when a timeline update is added")
        import sqlite3
        con = sqlite3.connect(os.path.join(data_dir, "dashboard.db"), timeout=10)
        con.execute("UPDATE incidents SET status = 'On Hold', hold_auto = 1 WHERE title = 'DB replica lag'")   # what the 3-day job does
        con.commit(); con.close()
        admin.goto(BASE + "/#alerts?status=On%20Hold")
        expect(admin.locator("#listTitle")).to_have_text("On Hold alerts")
        admin.get_by_role("link", name="DB replica lag").click()
        expect(admin.locator(".notice", has_text="On Hold")).to_contain_text("automatically")
        expect(admin.locator(".notice", has_text="On Hold")).to_contain_text("3 days")
        expect(admin.locator("#statusSelect")).to_have_value("On Hold")
        shot(admin, "08b-on-hold")
        admin.get_by_role("button", name="+ Add event").click()
        d = admin.locator("dialog[open]")
        d.get_by_role("button", name="Update", exact=True).click()
        d.get_by_label("Notes").fill("Replica caught up, still watching")
        d.get_by_role("button", name="Add event").click()
        expect(admin.locator("#statusSelect")).to_have_value("Ongoing")
        expect(admin.locator(".notice", has_text="On Hold")).to_have_count(0)
        expect(admin.locator(".timeline-item--activity", has_text="admin added an update, so the alert is back to Ongoing")).to_have_count(1)

        # =====================================================================
        step("export: events / users / all are downloadable and well-formed")
        admin.goto(BASE + "/#backup")
        downloads = {}
        for scope, label in (("events", "Alerts & events"), ("users", "Users"), ("all", "All data")):
            card = admin.locator(".export-card", has=admin.locator("h4", has_text=label))
            with admin.expect_download() as dl:
                card.get_by_role("link", name="Download .json").click()
            download = dl.value
            path = f"/tmp/{scope}.json"
            download.save_as(path)
            assert download.suggested_filename.startswith(f"sre-dashboard-{scope}-"), download.suggested_filename
            downloads[scope] = json.load(open(path))
        assert downloads["events"]["scope"] == "events" and "users" not in downloads["events"]
        assert len(downloads["events"]["incidents"]) == 4
        assert "incidents" not in downloads["users"] and len(downloads["users"]["users"]) == 4
        assert len(downloads["all"]["incidents"]) == 4 and len(downloads["all"]["users"]) == 4
        payment = next(i for i in downloads["events"]["incidents"] if i["title"].startswith("Payment"))
        assert len(payment["links"]) == 3 and len(payment["events"]) == 5, (len(payment["links"]), len(payment["events"]))
        # events are exported chronologically, with the automatic comments alongside
        times = [e["event_time"] for e in payment["events"]]
        assert times == sorted(times), times
        assert payment["events"][0]["label"] == "Backfilled first sign"
        assert [a["kind"] for a in payment["activity"]] == ["created", "took_care", "took_care"], [a["kind"] for a in payment["activity"]]
        assert sorted(payment["carers"]) == ["bob", "carol"] and payment["single_holder"] == 0, (payment["carers"], payment["single_holder"])
        assert "sort_order" not in payment["events"][0]
        held = next(i for i in downloads["events"]["incidents"] if i["title"] == "DB replica lag")
        assert [a["kind"] for a in held["activity"]] == ["created", "took_care", "left_care", "took_care", "resumed"], [a["kind"] for a in held["activity"]]
        assert held["carers"] == ["bob"] and held["single_holder"] == 1, (held["carers"], held["single_holder"])
        assert held["hold_auto"] == 0 and held["assignee"] == "", (held["hold_auto"], held["assignee"])   # taking care never assigned anyone
        assert all(i["severity"] in ("Show-stopper", "Critical", "High", "Error") for i in downloads["events"]["incidents"])
        assert {i["mode"] for i in downloads["events"]["incidents"]} <= {"takecare", "anyone", "private"}
        shot(admin, "09-backup-page")

        step("import (merge): re-importing the same file skips everything")
        admin.set_input_files("#importFile", "/tmp/events.json")
        expect(admin.locator("#fileInfo")).to_contain_text("4 alerts")
        admin.get_by_role("button", name="Import", exact=True).click()
        expect(admin.locator("#importResult")).to_contain_text("0 imported, 4 skipped")

        step("import (replace) restores a deleted alert, and the alert list shows it again")
        # delete an alert via the API as admin, then restore everything from the backup
        admin.goto(BASE + "/#alerts")
        admin.get_by_role("link", name="Disk filling on logging-3").click()
        admin.get_by_role("button", name="Edit", exact=True).click()
        admin.locator("dialog[open]").get_by_role("button", name="Delete alert").click()
        admin.locator("dialog[open]").last.get_by_role("button", name="Delete alert").click()
        expect(admin.locator("#listTitle")).to_be_visible()
        expect(admin.get_by_role("link", name="Disk filling on logging-3")).to_have_count(0)
        admin.goto(BASE + "/#backup")
        admin.set_input_files("#importFile", "/tmp/events.json")
        admin.get_by_text("Replace", exact=False).first.click()
        admin.locator("input[value=replace]").check()
        admin.get_by_role("button", name="Import", exact=True).click()
        admin.locator("dialog[open]").get_by_role("button", name="Replace data").click()
        expect(admin.locator("#importResult")).to_contain_text("4 imported")
        admin.goto(BASE + "/#alerts")
        expect(admin.get_by_role("link", name="Disk filling on logging-3")).to_be_visible()
        expect(admin.locator("tbody tr")).to_have_count(4)
        admin.get_by_role("link", name="DB replica lag").click()                     # the carers came back with the restore
        expect(admin.locator(".care")).to_contain_text("Taking care: bob")             # the holder came back with the restore
        expect(admin.locator(".assign")).to_contain_text("Unassigned")

        step("importing garbage is rejected with a clear message and changes nothing")
        bad = {"app": "sre-incident-dashboard", "format_version": 1, "incidents": [{"title": "x", "severity": "SEV9", "status": "Ongoing", "created_by": "z"}]}
        json.dump(bad, open("/tmp/bad.json", "w"))
        admin.goto(BASE + "/#backup")
        admin.set_input_files("#importFile", "/tmp/bad.json")
        admin.get_by_role("button", name="Import", exact=True).click()
        expect(admin.locator("#importResult")).to_contain_text("nothing was changed")
        expect(admin.locator("#importResult")).to_contain_text("severity")

        # =====================================================================
        step("anonymous visitors can read an alert and click its links, but see no controls")
        anon2 = new_context(viewport={"width": 1280, "height": 900}).new_page(); watch(anon2, "anon2")
        anon2.goto(BASE + "/#alerts")
        anon2.get_by_role("link", name="Payment API 5xx spike").click()
        expect(anon2.locator(".link-chip").first).to_be_visible()
        expect(anon2.locator(".timeline-item:not(.timeline-item--activity)")).to_have_count(5)
        expect(anon2.locator(".timeline-item--activity", has_text="alice created this alert")).to_have_count(1)
        for name in ("+ Add event", "New alert"):
            expect(anon2.get_by_role("button", name=name)).to_have_count(0)
        expect(anon2.locator("#statusSelect")).to_have_count(0)
        expect(anon2.locator("#banner")).to_be_visible()
        shot(anon2, "10-anonymous-detail")
        anon2.goto(BASE + "/#users")
        expect(anon2.locator(".empty-state")).to_contain_text("Super user access required")
        anon2.goto(BASE + "/#backup")
        expect(anon2.locator(".empty-state")).to_contain_text("Please sign in")

        step("mobile layout (375px) is usable")
        mob_ctx = new_context(viewport={"width": 375, "height": 800}, device_scale_factor=2)
        mob = mob_ctx.new_page(); watch(mob, "mobile")
        mob.goto(BASE)
        sign_in(mob, "alice", "alice-password-1")
        mob.goto(BASE + "/#")
        shot(mob, "11-mobile-dashboard")
        overflow = mob.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 1, f"dashboard overflows horizontally by {overflow}px on mobile"
        mob.goto(BASE + "/#alerts")
        mob.get_by_role("link", name="Payment API 5xx spike").click()
        shot(mob, "12-mobile-detail")
        overflow = mob.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 1, f"detail overflows horizontally by {overflow}px on mobile"

        step("mobile: the bell panel and My alerts fit a 375px screen")
        mob.goto(BASE + "/#")
        mob.locator("#notifBtn").click()
        box = mob.locator("#notifPanel").bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 375.5, box
        shot(mob, "13-mobile-bell")
        mob.keyboard.press("Escape")
        mob.goto(BASE + "/#alerts?status=Ongoing&mine=1")
        expect(mob.locator(".mine-group")).to_have_count(2)
        overflow = mob.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 1, f"My alerts overflows horizontally by {overflow}px on mobile"
        shot(mob, "14-mobile-my-alerts")

        browser.close()
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except Exception:
        server.kill()
    shutil.rmtree(data_dir, ignore_errors=True)

print()
if problems:
    print("BROWSER ERRORS:")
    for pr in problems:
        print("  *", pr)
    sys.exit(1)
print(f"E2E OK: {len(steps)} steps, no console errors")
