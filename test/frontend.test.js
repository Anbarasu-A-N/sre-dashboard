'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', rel)).href);

describe('html`` template tag escapes by default', () => {
  test('interpolated values are escaped, nested templates are not double-escaped', async () => {
    const { html, raw, esc } = await load('util.js');
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const out = html`<p title="${evil}">${evil}</p>`.text;
    assert.ok(!out.includes('<img'));
    assert.ok(!/title="[^"]*"[^>]*onerror/.test(out.replace(/&quot;/g, '')));
    assert.ok(out.includes('&lt;img'));

    const inner = html`<b>${'a & b'}</b>`;
    assert.equal(html`<i>${inner}</i>`.text, '<i><b>a &amp; b</b></i>');
    assert.equal(html`${[html`<li>${1}</li>`, html`<li>${'<x>'}</li>`]}`.text, '<li>1</li><li>&lt;x&gt;</li>');
    assert.equal(html`${null}${undefined}${false}`.text, '');
    assert.equal(html`${0}`.text, '0');
    assert.equal(html`${raw('<hr>')}`.text, '<hr>');
    assert.equal(esc(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
  });

  test('timeAgo and plural', async () => {
    const { timeAgo, plural } = await load('util.js');
    const now = Date.parse('2026-10-15T12:00:00Z');
    assert.equal(timeAgo('2026-10-15T11:59:50Z', now), 'just now');
    assert.equal(timeAgo('2026-10-15T11:15:00Z', now), '45m ago');
    assert.equal(timeAgo('2026-10-15T09:30:00Z', now), '2h 30m ago');
    assert.equal(timeAgo('2026-10-13T08:00:00Z', now), '2d 4h ago');
    assert.equal(plural(1, 'alert'), '1 alert');
    assert.equal(plural(3, 'alert'), '3 alerts');
  });
});

describe('links', () => {
  test('safeUrl only allows http(s)', async () => {
    const { safeUrl } = await load('links.js');
    assert.equal(safeUrl('https://grafana.example.com/d/1'), 'https://grafana.example.com/d/1');
    assert.equal(safeUrl('http://x.example'), 'http://x.example/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x', 'vbscript:x', '//evil.example', 'not a url', '', null, undefined]) {
      assert.equal(safeUrl(bad), null, String(bad));
    }
  });

  test('chips open in a new tab with noopener and drop unsafe links defensively', async () => {
    const { linkChips } = await load('links.js');
    const out = linkChips([
      { name: 'Grafana', url: 'https://grafana.example.com' },
      { name: '<script>x</script>', url: 'https://ok.example' },
      { name: 'evil', url: 'javascript:alert(1)' },
    ]).text;
    assert.equal((out.match(/<a /g) || []).length, 2);
    assert.ok(out.includes('target="_blank"'));
    assert.ok(out.includes('rel="noopener noreferrer"'));
    assert.ok(!out.includes('javascript:'));
    assert.ok(!out.includes('<script>'));
    assert.equal(linkChips([]).text, '');
    assert.equal(linkChips(undefined).text, '');
  });
});

describe('charts', () => {
  test('niceScale gives round maxima and whole-number steps', async () => {
    const { niceScale } = await load('charts.js');
    assert.deepEqual(niceScale(0), { max: 4, step: 1 });
    assert.deepEqual(niceScale(3), { max: 4, step: 1 });
    assert.deepEqual(niceScale(5), { max: 6, step: 2 });
    assert.deepEqual(niceScale(10), { max: 10, step: 5 });
    assert.deepEqual(niceScale(23), { max: 30, step: 10 });
    assert.deepEqual(niceScale(100), { max: 100, step: 50 });
    for (let n = 0; n < 500; n++) {
      const { max, step } = niceScale(n);
      assert.ok(max >= n, `max covers ${n}`);
      assert.ok(Number.isInteger(step) && step >= 1);
      assert.equal(max % step, 0);
    }
  });

  test('donut draws one arc per non-zero segment, escapes labels, handles empty data', async () => {
    const { donut } = await load('charts.js');
    const svg = donut([
      { label: 'Ongoing', value: 3, color: '#e5484d', href: '#alerts?status=Ongoing' },
      { label: 'Evil <b>', value: 1, color: '#30a46c', href: '#x' },
      { label: 'Zero', value: 0, color: '#000', href: '#y' },
    ], { centerValue: 4, centerLabel: 'alerts' }).text;
    assert.equal((svg.match(/donut__seg/g) || []).length, 2);
    assert.ok(svg.includes('Evil &lt;b&gt;: 1'));
    assert.ok(svg.includes('>4<'));

    const empty = donut([{ label: 'A', value: 0, color: '#fff', href: '#' }], { centerValue: 0 }).text;
    assert.equal((empty.match(/donut__seg/g) || []).length, 0);
    assert.ok(empty.includes('<svg'));

    const single = donut([{ label: 'Only', value: 5, color: '#fff', href: '#' }]).text;
    assert.equal((single.match(/donut__seg/g) || []).length, 1);
  });

  test('timeBars renders a column per day and scales bar heights to the axis max', async () => {
    const { timeBars } = await load('charts.js');
    const labels = ['2026-10-13', '2026-10-14', '2026-10-15'];
    const out = timeBars({
      labels,
      series: [
        { name: 'Created', color: '#8b95a1', values: [0, 2, 4] },
        { name: 'Completed', color: '#30a46c', values: [0, 0, 1] },
      ],
    }).text;
    assert.equal((out.match(/class="bars__col"/g) || []).length, 3);
    assert.ok(out.includes('height:100%')); // 4 of max 4
    assert.ok(out.includes('height:50%'));  // 2 of max 4
    assert.ok(out.includes('height:25%'));  // 1 of max 4
    assert.ok(out.includes('height:0%'));   // zero stays flat
    assert.match(out, /Created 4, Completed 1/);
  });

  test('timeBars copes with all-zero and long ranges', async () => {
    const { timeBars } = await load('charts.js');
    const labels = Array.from({ length: 90 }, (_, i) => `2026-07-${String((i % 28) + 1).padStart(2, '0')}`);
    const out = timeBars({ labels, series: [{ name: 'Created', color: '#fff', values: labels.map(() => 0) }] }).text;
    assert.equal((out.match(/class="bars__col"/g) || []).length, 90);
    assert.ok(!out.includes('NaN'));
  });

  test('workloadBars: unassigned row has no "created" bar and values never go NaN', async () => {
    const { workloadBars } = await load('charts.js');
    const out = workloadBars([
      { label: 'alice', created: 5, working: 2, createdHref: '#a', workingHref: '#b' },
      { label: 'Unassigned', created: null, working: 3, muted: true, createdHref: '', workingHref: '#c' },
      { label: 'zed', created: 0, working: 0, createdHref: '#d', workingHref: '#e' },
    ], { createdColor: '#111', workingColor: '#222' }).text;
    assert.ok(!out.includes('NaN'));
    assert.equal((out.match(/title="Created:/g) || []).length, 2);
    assert.equal((out.match(/title="Working on:/g) || []).length, 3);
    assert.ok(out.includes('wl-row--muted'));
  });

  test('stackBar skips empty parts and has an empty state', async () => {
    const { stackBar } = await load('charts.js');
    const out = stackBar([{ label: 'Ongoing', value: 2, color: '#e5484d' }, { label: 'Completed', value: 0, color: '#30a46c' }]).text;
    assert.equal((out.match(/<span/g) || []).length, 1);
    assert.ok(stackBar([{ label: 'x', value: 0, color: '#fff' }]).text.includes('stack--empty'));
  });
});

describe('timeline merge', () => {
  test('events and automatic activity interleave chronologically; events win ties', async () => {
    const { mergeTimeline } = await load('util.js');
    const events = [
      { id: 1, label: 'RCA', event_time: '2026-10-15T12:00:00.000Z' },
      { id: 2, label: 'Issue Occurred', event_time: '2026-10-15T09:00:00.000Z' },
    ];
    const activity = [
      { id: 1, text: 'alice created this alert', created_at: '2026-10-15T09:30:00.000Z' },
      { id: 2, text: 'bob took care of this alert', created_at: '2026-10-15T10:00:00.000Z' },
      { id: 3, text: 'tie with RCA', created_at: '2026-10-15T12:00:00.000Z' },
    ];
    const merged = mergeTimeline(events, activity);
    assert.deepEqual(merged.map((m) => `${m.type}:${m.data.label || m.data.text}`), [
      'event:Issue Occurred',
      'activity:alice created this alert',
      'activity:bob took care of this alert',
      'event:RCA',
      'activity:tie with RCA',
    ]);
    assert.deepEqual(mergeTimeline([], []), []);
    assert.equal(mergeTimeline([], activity).length, 3);
  });
});

describe('alert list titles', () => {
  test('describe the active filters', async () => {
    const { titleFor } = await load('views/alerts.js');
    assert.equal(titleFor({}), 'All alerts');
    assert.equal(titleFor({ status: 'Ongoing' }), 'Ongoing alerts');
    assert.equal(titleFor({ severity: 'Show-stopper', active: '1' }), 'Active · Show-stopper alerts');
    assert.equal(titleFor({ assignee: '__none__', active: '1' }), 'Active · Unassigned alerts');
    assert.equal(titleFor({ assignee: 'alice', active: '1' }), 'Active · Assigned to alice alerts');
    assert.equal(titleFor({ created_by: 'bob' }), 'Opened by bob alerts');
    // "My alerts" button: the same filters, prefixed
    assert.equal(titleFor({ mine: '1' }), 'My alerts');
    assert.equal(titleFor({ mine: '1', status: 'Ongoing' }), 'My Ongoing alerts');
    assert.equal(titleFor({ mine: '1', status: 'On Hold' }), 'My On Hold alerts');
    assert.equal(titleFor({ mine: '1', severity: 'Critical', active: '1' }), 'My Active · Critical alerts');
  });

  test('"My alerts" has exactly two groups: assigned to me, and taking care', async () => {
    const { groupMine } = await load('views/alerts.js');
    const rows = [
      { id: 1, mine_kind: 'assigned' }, { id: 2, mine_kind: 'care' },
      { id: 3, mine_kind: 'assigned' }, { id: 4, mine_kind: 'care' }, { id: 5, mine_kind: 'care' },
    ];
    const g = groupMine(rows);
    assert.deepEqual(Object.keys(g), ['assigned', 'care']);
    assert.deepEqual(g.assigned.map((r) => r.id), [1, 3]);
    assert.deepEqual(g.care.map((r) => r.id), [2, 4, 5]);
    assert.deepEqual(groupMine([]), { assigned: [], care: [] });
  });
});
