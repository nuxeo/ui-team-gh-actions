// Fix deadlines for Critical/High tickets: date arithmetic, the open list, its persistence and where it is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listOpenHigh } from '../apply.mjs';
import { DEFAULT_CONFIG, loadConfig } from '../lib/config.mjs';
import {
  addDays,
  daysLeftText,
  displayDate,
  keptStarts,
  latestStarts,
  localDate,
  openHighTickets,
  raiseDeadline,
  raiseStarts,
} from '../lib/due.mjs';
import { OWNED_LABEL } from '../lib/reconcile.mjs';
import { reportNeeded, runReport, severityComment, teamsCard, ticketDescription } from '../lib/render.mjs';
import { ControlState } from '../lib/state.mjs';
import { textOf } from '../lib/util.mjs';
import { EL, RUN, WEB, blocked, bootstrapPlan, group, liveAlerts, registerTickets } from './fixtures.mjs';
import { FakeJira, cardTables, config, createGroup, executor } from './support.mjs';

const NOW = new Date('2026-11-24T07:30:00Z'); // 24 Nov 2026, 13:00 IST

test('due dates are calendar days in the configured timezone', () => {
  assert.equal(addDays('2026-11-15', 15), '2026-11-30');
  assert.equal(addDays('2026-11-20', 15), '2026-12-05');
  assert.equal(addDays('2026-12-25', 15), '2027-01-09');
  assert.equal(addDays('2028-02-20', 15), '2028-03-06');
  // 23:59 and 00:00 IST.
  assert.equal(localDate(new Date('2026-11-14T18:29:00Z'), 'Asia/Kolkata'), '2026-11-14');
  assert.equal(localDate(new Date('2026-11-14T18:30:00Z'), 'Asia/Kolkata'), '2026-11-15');
  assert.equal(displayDate('2026-12-09'), '09 Dec 2026');
  assert.deepEqual([15, 1, 0, -1, -4].map(daysLeftText), [
    '15 days left',
    '1 day left',
    'Due today',
    'Overdue by 1 day',
    'Overdue by 4 days',
  ]);
});

test('only a raise into Critical/High starts the clock', () => {
  assert.deepEqual(raiseDeadline('low', 'high', config, NOW), { dueFrom: '2026-11-24', dueBy: '2026-12-09' });
  assert.deepEqual(raiseDeadline(null, 'critical', config, NOW), { dueFrom: '2026-11-24', dueBy: '2026-12-09' });
  assert.equal(raiseDeadline('high', 'critical', config, NOW), null);
  assert.equal(raiseDeadline('low', 'medium', config, NOW), null);
  assert.deepEqual(raiseDeadline('medium', 'high', { ...config, dueDays: 7 }, NOW).dueBy, '2026-12-01');
});

test('"dueDays" must be a whole number of days', () => {
  const raw = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'));
  assert.equal(raw.dueDays, 15);
  const dir = mkdtempSync(path.join(tmpdir(), 'due-'));
  for (const value of [0, 1.5, '15', 400]) {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ ...raw, dueDays: value }));
    assert.throws(() => loadConfig(file, {}), /dueDays/);
  }
});

const ticket = (key, severity, extra = {}) => {
  return {
    key,
    project: key.split('-')[0],
    status: 'Open',
    statusCategory: 'new',
    severity,
    labels: [OWNED_LABEL],
    ownership: null,
    created: '2026-11-05T10:00:00.000-0700',
    ...extra,
  };
};
const emptyOutcome = (extra = {}) => {
  return { groups: [], severityRaises: [], ...extra };
};

test('the open list holds tracked, not-Done Critical/High tickets, On Hold included, overdue first', () => {
  const tickets = [
    ticket('APP-1', 'high'),
    ticket('APP-2', 'critical', { status: 'On Hold', created: '2026-11-20T10:00:00.000+0530' }),
    ticket('APP-3', 'high', { status: 'In Progress', statusCategory: 'indeterminate' }),
    ticket('APP-4', 'medium'),
    ticket('APP-5', 'high', { labels: ['Security'] }),
    ticket('APP-6', 'high', { status: 'Resolved', statusCategory: 'done' }),
    ticket('LIB-7', 'high', { labels: [], ownership: { repository: EL, alerts: { 104: {}, 999: {} } } }),
  ];
  const alerts = [{ repository: EL, number: 104 }];
  const open = openHighTickets({ tickets, alerts, outcome: emptyOutcome(), config, now: NOW });
  assert.equal(open.available, true);
  assert.deepEqual(
    open.rows.map((row) => [row.key, row.status, row.dueDate, row.daysLeft]),
    [
      ['APP-1', 'Open', '2026-11-20', -4],
      ['APP-3', 'In Progress', '2026-11-20', -4],
      ['LIB-7', 'Open', '2026-11-20', -4],
      ['APP-2', 'On Hold', '2026-12-05', 11],
    ],
  );
  const lib = open.rows.find((row) => row.key === 'LIB-7');
  assert.equal(lib.repository, EL);
  assert.equal(lib.alerts, 1);
  assert.equal(open.rows.find((row) => row.key === 'APP-1').repository, WEB);
});

test('the open list starts a raised ticket at its recorded raise, and overlays what this run changed', () => {
  const tickets = [ticket('APP-1', 'medium', { labels: [] }), ticket('APP-8', 'high'), ticket('APP-9', 'low')];
  const outcome = emptyOutcome({
    groups: [
      {
        ...group(`${WEB}:new`, WEB, 'create', undefined, 'high', [1, 2]),
        ticketKey: 'APP-100',
        action: 'created',
        createdOn: '2026-11-23',
      },
      {
        ...group(`${WEB}:hold`, WEB, 'create', undefined, 'critical', [3]),
        ticketKey: 'APP-101',
        action: 'created',
        kind: 'blocked',
        onHold: true,
      },
      { ...group(`${WEB}:old`, WEB, 'adopt', 'APP-1', 'medium', [4]), ticketKey: 'APP-1', action: 'adopted' },
      { ...group(`${WEB}:x`, WEB, 'create', undefined, 'high', [5]), ticketKey: 'APP-102', action: 'proposed create' },
    ],
    severityRaises: [
      { ticket: 'APP-1', from: 'medium', to: 'high', alerts: [], applied: true, dueFrom: '2026-11-24' },
      { ticket: 'APP-9', from: 'low', to: 'high', alerts: [], applied: false },
    ],
  });
  const dueFrom = latestStarts({ 'APP-8': '2026-11-22' }, raiseStarts(outcome.severityRaises));
  const open = openHighTickets({ tickets, alerts: [], outcome, config, dueFrom, now: NOW });
  assert.deepEqual(
    open.rows.map((row) => [row.key, row.severity, row.status, row.dueFrom, row.daysLeft]),
    [
      ['APP-8', 'high', 'Open', '2026-11-22', 13],
      ['APP-100', 'high', 'Open', '2026-11-23', 14],
      ['APP-101', 'critical', 'On Hold', '2026-11-24', 15],
      ['APP-1', 'high', 'Open', '2026-11-24', 15],
    ],
  );
  assert.equal(open.rows.find((row) => row.key === 'APP-100').alerts, 2);
});

test('without the ticket read the open list is unavailable, never empty', () => {
  assert.deepEqual(openHighTickets({ tickets: undefined, outcome: emptyOutcome(), config, now: NOW }), {
    available: false,
    rows: [],
  });
});

test('the latest raise into Critical/High wins, so lowering and re-raising starts a new clock', () => {
  // Raised on 1 Oct, lowered by a person, raised again today: the stored date must not hide today's raise.
  const raises = [
    { ticket: 'APP-1', applied: true, dueFrom: '2026-11-24' },
    { ticket: 'APP-3', applied: false, dueFrom: '2026-11-24' },
  ];
  const starts = latestStarts({ 'APP-1': '2026-10-01', 'APP-2': '2026-11-01' }, raiseStarts(raises));
  assert.deepEqual(starts, { 'APP-1': '2026-11-24', 'APP-2': '2026-11-01' });
  const open = openHighTickets({
    tickets: [ticket('APP-1', 'high')],
    alerts: [],
    outcome: emptyOutcome(),
    config,
    dueFrom: starts,
    now: NOW,
  });
  assert.deepEqual([open.rows[0].dueDate, open.rows[0].daysLeft], ['2026-12-09', 15]);
});

test('a raise into High saves its start in the run state at once, also when a later run recovers it', async () => {
  const today = localDate(new Date(), config.timezone);
  const tickets = registerTickets();
  const jira = new FakeJira(tickets);
  const { exec, control } = await executor(jira, tickets);
  const raise = { ticket: 'APP-31', from: 'medium', to: 'high', alerts: [`${WEB}#14`] };
  await exec.raiseCovered(raise, new Set());
  assert.equal(control.state.dueFrom['APP-31'], today);
  // An interrupted run raised LIB-44 on 20 Nov and stopped before recording it; the next run recovers the raise.
  jira.issues.get('LIB-44').fields[config.severityField] = { id: config.severityOptions.high };
  const later = await executor(jira, tickets, { runId: 'week-2' });
  const planned = { from: 'medium', to: 'high', alerts: [], dueFrom: '2026-11-20', dueBy: '2026-12-05' };
  await later.control.reserve({
    id: 'week-1:LIB-44:severity-high',
    kind: 'severity',
    runId: 'week-1',
    target: 'LIB-44',
    recovery: { key: 'LIB-44', raiseTo: 'high', raise: planned },
  });
  // The start is saved before the entry is settled, so a stop in between cannot lose it.
  const settle = later.control.settle.bind(later.control);
  later.control.settle = async (id, ...rest) => {
    if (id === 'week-1:LIB-44:severity-high') {
      assert.equal(later.control.state.dueFrom?.['LIB-44'], '2026-11-20');
    }
    return settle(id, ...rest);
  };
  await later.exec.recover();
  assert.equal(later.control.state.dueFrom['LIB-44'], '2026-11-20');
  assert.equal(later.control.state.dueFrom['APP-31'], today);
});

test('kept start dates are those of tickets still open at Critical/High, or all when the list is unknown', () => {
  const starts = { 'APP-1': '2026-11-24', 'APP-5': '2026-10-01' };
  assert.deepEqual(keptStarts(starts, { available: true, rows: [{ key: 'APP-1' }] }), { 'APP-1': '2026-11-24' });
  assert.deepEqual(keptStarts(starts, { available: false, rows: [] }), starts);
  assert.deepEqual(keptStarts(undefined, undefined), {});
});

test('a verified hold or raise counts even when a later step for that ticket failed', () => {
  const tickets = [ticket('APP-1', 'medium', { labels: [] }), ticket('APP-2', 'high', { labels: [] })];
  const outcome = emptyOutcome({
    groups: [
      {
        ...group(`${WEB}:a`, WEB, 'adopt', 'APP-2', 'high', [1]),
        ticketKey: 'APP-2',
        action: 'proposed adopt',
        heldVerified: true,
      },
    ],
    severityRaises: [{ ticket: 'APP-1', from: 'medium', to: 'high', alerts: [], applied: true, dueFrom: '2026-11-24' }],
  });
  const open = openHighTickets({ tickets, alerts: [], outcome, config, dueFrom: { 'APP-1': '2026-11-24' }, now: NOW });
  assert.deepEqual(
    open.rows.map((row) => [row.key, row.status, row.dueFrom]),
    [
      ['APP-2', 'On Hold', '2026-11-05'],
      ['APP-1', 'Open', '2026-11-24'],
    ],
  );
});

test('a created ticket is On Hold once the transition is verified, even if its reason comment failed', async () => {
  const jira = new FakeJira();
  jira.failNext = { name: 'addComment', error: { status: 400 } };
  const { exec } = await executor(jira, []);
  const unpatched = group(`${EL}:pkg`, EL, 'create', undefined, 'high', [106], {
    ...blocked('no-upstream-patch', 'https://github.com/advisories/GHSA-0000-0000-0007'),
  });
  // As apply() builds it: the plan group plus what the executor records.
  const report = { ...unpatched, action: 'proposed create' };
  await exec.create(unpatched, report);
  assert.equal(jira.issues.get(report.ticketKey).fields.status.name, 'On Hold');
  assert.equal(report.onHold, true);
  const card = teamsCard({ ...cardOutcome({ available: true, rows: [] }), groups: [report] }, teamsConfig, NOW);
  assert.match(cardTables(card)['Tickets created'][0][2], /^On Hold \(no patch\)$/);
  assert.equal(cardTables(card)['Tickets updated'], undefined, 'a created ticket is listed once');
  // The open list uses the start date the description states.
  assert.equal(report.createdOn, localDate(new Date(), config.timezone));
  assert.match(textOf(jira.issues.get(report.ticketKey).fields.description), /Fix due by/);
});

test('a hold verified before a later step failed is still listed as a change', () => {
  const held = {
    ...group(`${EL}:b`, EL, 'adopt', 'LIB-45', 'low', [105]),
    kind: 'blocked',
    ticketKey: 'LIB-45',
    action: 'proposed adopt',
    heldVerified: true,
    onHold: true,
  };
  const outcome = { ...cardOutcome({ available: true, rows: [] }), groups: [held] };
  assert.deepEqual(cardTables(teamsCard(outcome, teamsConfig, NOW))['Tickets updated'], [
    ['[LIB-45](https://jira.example/browse/LIB-45)', 'Low', 'Put On Hold'],
  ]);
  const report = {
    ...outcome,
    mode: 'automatic',
    planDetermined: true,
    counts: { alerts: 1, uniqueAdvisories: 1, covered: 0 },
    cleared: [],
    ambiguous: [],
    warnings: [],
    actions: [],
    validationErrors: [],
  };
  assert.equal(reportNeeded(report), true);
  assert.match(runReport(report, config).map(textOf).join('\n'), /LIB-45 .*blocked; put On Hold/);
});

const teamsConfig = { ...config, controlIssue: 'APP-99' };
const cardOutcome = (openHigh) => {
  return {
    runId: RUN,
    complete: true,
    failures: [],
    newBySeverity: {},
    counts: { alerts: 3, covered: 3 },
    groups: [],
    severityRaises: [],
    needsReview: [],
    closedMismatches: [],
    repositories: [{ name: WEB }],
    openHigh,
  };
};
const row = (key, severity, status, daysLeft) => {
  return { key, severity, status, dueFrom: '2026-11-05', dueDate: '2026-11-20', daysLeft, repository: WEB, alerts: 1 };
};

test('Teams: the open Critical/High table is last, flags overdue rows and caps its rows', () => {
  const rows = [row('APP-1', 'critical', 'In Progress', -4), row('APP-2', 'high', 'On Hold', 15)];
  const card = teamsCard(cardOutcome({ available: true, rows }), teamsConfig, NOW);
  const body = card.attachments[0].content.body;
  assert.deepEqual(cardTables(card)['Open Critical / High tickets'], [
    ['[APP-1](https://jira.example/browse/APP-1)', 'Critical', 'In Progress', '20 Nov 2026', '⚠️ Overdue by 4 days'],
    ['[APP-2](https://jira.example/browse/APP-2)', 'High', 'On Hold', '20 Nov 2026', '15 days left'],
  ]);
  const tableIndex = body.findIndex((item) => item.type === 'Table');
  assert.equal(body[tableIndex].rows[1].style, 'attention');
  assert.equal(body[tableIndex].rows[2].style, undefined);
  assert.equal(tableIndex, body.length - 2, 'the table is the last section before the footer');
  const many = Array.from({ length: 13 }, (_, index) => row(`APP-${index}`, 'high', 'Open', 3));
  const capped = teamsCard(cardOutcome({ available: true, rows: many }), teamsConfig, NOW);
  assert.equal(cardTables(capped)['Open Critical / High tickets'].length, 10);
  assert.match(JSON.stringify(capped), /Open Critical \/ High tickets · 13/);
  assert.match(JSON.stringify(capped), /\+3 more in the \[full report\]/);
  const unavailable = JSON.stringify(teamsCard(cardOutcome({ available: false, rows: [] }), teamsConfig, NOW));
  assert.match(unavailable, /Open Critical \/ High tickets:\*\* not available \(scan incomplete\)/);
  assert.doesNotMatch(unavailable, /No Critical or High security tickets/);
});

test('Teams: a severity raise is one updated row saying where it came from; due dates stay in the open table', () => {
  const outcome = {
    ...cardOutcome({ available: true, rows: [row('LIB-50', 'high', 'Open', 15)] }),
    severityRaises: [{ ticket: 'LIB-50', from: 'low', to: 'high', alerts: [], applied: true, dueFrom: '2026-11-24' }],
  };
  const card = teamsCard(outcome, teamsConfig, NOW);
  assert.deepEqual(cardTables(card)['Tickets updated'], [
    ['[LIB-50](https://jira.example/browse/LIB-50)', 'High', 'Severity raised from Low'],
  ]);
  assert.equal((JSON.stringify(card).match(/20 Nov 2026/g) ?? []).length, 1);
});

test('new Critical/High tickets and raises into Critical/High say when the fix is due', () => {
  const alerts = [];
  const created = ticketDescription({
    group: group(`${WEB}:new`, WEB, 'create', undefined, 'high', []),
    alerts,
    evidence: {},
    config,
    runId: RUN,
    due: raiseDeadline(null, 'high', config, NOW),
  });
  assert.match(textOf(created), /Fix due by 09 Dec 2026 \(Critical\/High: 15 days from creation\)\./);
  const medium = ticketDescription({
    group: group(`${WEB}:new`, WEB, 'create', undefined, 'medium', []),
    alerts,
    evidence: {},
    config,
    runId: RUN,
    due: raiseDeadline(null, 'medium', config, NOW),
  });
  assert.doesNotMatch(textOf(medium), /Fix due by/);
  const raise = { from: 'low', to: 'high', alerts: ['#1'], ...raiseDeadline('low', 'high', config, NOW) };
  assert.match(
    textOf(severityComment({ raise, runId: RUN, marker: 'm' })),
    /Defect Severity raised from Low to High\. Fix due by 09 Dec 2026 \(15 days from this raise\)\./,
  );
  const noClock = textOf(
    severityComment({ raise: { from: 'high', to: 'critical', alerts: [] }, runId: RUN, marker: 'm' }),
  );
  assert.doesNotMatch(noClock, /Fix due by/);
});

test('a covered raise into High records its start, and its comment carries the same due date', async () => {
  const tickets = registerTickets();
  const jira = new FakeJira(tickets);
  const { exec, outcome } = await executor(jira, tickets);
  const raise = { ticket: 'APP-31', from: 'medium', to: 'high', alerts: [`${WEB}#14`] };
  outcome.severityRaises.push(raise);
  await exec.raiseCovered(raise, new Set());
  const today = localDate(new Date(), config.timezone);
  assert.equal(raise.applied, true);
  assert.equal(raise.dueFrom, today);
  const comments = (await jira.allComments('APP-31')).map((comment) => textOf(comment.body));
  assert.ok(comments.some((comment) => comment.includes(`Fix due by ${displayDate(addDays(today, 15))}`)));
});

test('report: the open table with repository, alerts and start, and due lines where this run started a clock', () => {
  const created = {
    ...group(`${WEB}:new`, WEB, 'create', undefined, 'high', [1]),
    ticketKey: 'APP-100',
    action: 'created',
  };
  const outcome = {
    ...cardOutcome({
      available: true,
      rows: [
        { ...row('APP-100', 'high', 'Open', 15), dueFrom: '2026-11-24', dueDate: '2026-12-09' },
        { ...row('LIB-50', 'high', 'Open', 15), dueFrom: '2026-11-24', dueDate: '2026-12-09', repository: EL },
        row('APP-1', 'critical', 'In Progress', -4),
      ],
    }),
    mode: 'automatic',
    planDetermined: true,
    counts: { alerts: 3, uniqueAdvisories: 3, covered: 1 },
    groups: [created],
    severityRaises: [
      { ticket: 'LIB-50', from: 'low', to: 'high', alerts: [`${EL}#5`], applied: true, dueFrom: '2026-11-24' },
    ],
    cleared: [],
    ambiguous: [],
    warnings: [],
    actions: [],
    validationErrors: [],
  };
  const text = runReport(outcome, config)
    .map((document) => textOf(document))
    .join('\n');
  assert.match(text, /Due: 09 Dec 2026 \(15 days from creation\)/);
  assert.match(
    text,
    /LIB-50 · severity raised from Low to High · .*#5\nDue: 09 Dec 2026 \(15 days from the severity raise\)/,
  );
  assert.match(text, /Open Critical \/ High tickets · 3/);
  assert.match(text, /Overdue by 4 days/);
  assert.match(text, /"Due from" \+ 15 calendar days \(Asia\/Kolkata\)/);
  const [document] = runReport(outcome, config);
  const table = document.content.find((node) => node.type === 'table');
  assert.deepEqual(
    table.content[0].content.map((cell) => textOf(cell).trim()),
    ['Ticket', 'Severity', 'Status', 'Repository', 'Alerts', 'Due from', 'Due date', 'Days left'],
  );
  assert.deepEqual(
    table.content[2].content.map((cell) => textOf(cell).trim()),
    ['LIB-50', 'High', 'Open', 'lib', '1', '24 Nov 2026', '09 Dec 2026', '15 days left'],
  );
  // A severity raise alone is a change worth a report.
  assert.equal(reportNeeded({ ...outcome, groups: [] }), true);
  assert.equal(reportNeeded({ ...outcome, groups: [], severityRaises: [] }), false);
});

test('Teams: a ticket this run put On Hold without other changes is still reported', () => {
  const held = {
    ...group(`${EL}:b`, EL, 'keep', 'LIB-45', 'low', [105]),
    kind: 'blocked',
    ticketKey: 'LIB-45',
    action: 'kept',
    heldVerified: true,
  };
  const outcome = { ...cardOutcome({ available: true, rows: [] }), groups: [held] };
  assert.deepEqual(cardTables(teamsCard(outcome, teamsConfig, NOW))['Tickets updated'], [
    ['[LIB-45](https://jira.example/browse/LIB-45)', 'Low', 'Put On Hold'],
  ]);
  const report = {
    ...outcome,
    mode: 'automatic',
    planDetermined: true,
    counts: { alerts: 1, uniqueAdvisories: 1, covered: 1 },
    cleared: [],
    ambiguous: [],
    warnings: [],
    actions: [],
    validationErrors: [],
  };
  assert.equal(reportNeeded(report), true);
  assert.match(
    runReport(report, config).map(textOf).join('\n'),
    /LIB-45 · existing ticket · Low · blocked; put On Hold/,
  );
  assert.equal(reportNeeded({ ...report, groups: [{ ...held, heldVerified: false }] }), false);
});

test('the report is posted when the card shows only part of the open list, and splits long tables by size', () => {
  const base = {
    ...cardOutcome({ available: true, rows: [] }),
    mode: 'automatic',
    planDetermined: true,
    cleared: [],
    ambiguous: [],
    warnings: [],
    actions: [],
    validationErrors: [],
  };
  const rows = (count) =>
    Array.from({ length: count }, (_, index) => {
      return { ...row(`APP-${index}`, 'high', 'In Progress with a longer workflow status name', 3) };
    });
  assert.equal(reportNeeded({ ...base, openHigh: { available: true, rows: rows(10) } }), false);
  assert.equal(reportNeeded({ ...base, openHigh: { available: true, rows: rows(11) } }), true);
  const documents = runReport({ ...base, openHigh: { available: true, rows: rows(60) } }, config);
  const tables = documents.flatMap((document) => document.content.filter((node) => node.type === 'table'));
  assert.ok(tables.length > 2);
  assert.equal(
    tables.reduce((sum, table) => sum + table.content.length - 1, 0),
    60,
  );
  for (const table of tables) {
    assert.ok(JSON.stringify(table).length <= 20000, 'each table fits well inside one comment');
  }
});

test('the run takes start dates from its state and its own raises, latest first', () => {
  const control = {
    state: { dueFrom: { 'APP-1': '2026-11-01', 'APP-2': '2026-11-02', 'APP-3': '2026-10-01' } },
  };
  const inventory = {
    tickets: [ticket('APP-1', 'high'), ticket('APP-2', 'high'), ticket('APP-3', 'high')],
    alerts: [],
  };
  const outcome = emptyOutcome({
    failures: [],
    severityRaises: [{ ticket: 'APP-3', from: 'low', to: 'high', alerts: [], applied: true, dueFrom: '2026-11-24' }],
  });
  listOpenHigh(control, config, inventory, outcome);
  assert.deepEqual(outcome.dueStarts, { 'APP-1': '2026-11-01', 'APP-2': '2026-11-02', 'APP-3': '2026-11-24' });
  assert.deepEqual(
    Object.fromEntries(outcome.openHigh.rows.map((item) => [item.key, item.dueFrom])),
    outcome.dueStarts,
  );
});

test('Teams: trimming drops whole sections, so no table loses its title or its title its table', () => {
  const site = `https://jira.example/${'x'.repeat(600)}`;
  const tickets = (action) =>
    Array.from({ length: 10 }, (_, index) => {
      return {
        ...group(`${WEB}:${action}${index}`, WEB, 'create', undefined, 'high', [index]),
        ticketKey: `APP-${index}`,
        action,
      };
    });
  const outcome = {
    ...cardOutcome({
      available: true,
      rows: Array.from({ length: 10 }, (_, index) => row(`APP-${index}`, 'high', 'Open', 3)),
    }),
    complete: false,
    failures: Array.from({ length: 10 }, () => '€'.repeat(400)),
    groups: [...tickets('created'), ...tickets('adopted')],
  };
  const card = teamsCard(outcome, { ...teamsConfig, jiraSite: site }, NOW);
  const body = card.attachments[0].content.body;
  assert.match(JSON.stringify(card), /more section\(s\) are in the \[full report\]/);
  body.forEach((item, index) => {
    if (item.type === 'Table') {
      assert.match(body[index - 1].text, /^\*\*[^*]+ · \d+\*\*$/);
    }
    if (/^\*\*(Tickets created|Tickets updated|Open Critical \/ High tickets) · /.test(item.text ?? '')) {
      assert.equal(body[index + 1]?.type, 'Table', `${item.text} keeps its table`);
    }
  });
  assert.equal(cardTables(card)['Open Critical / High tickets'].length, 10);
});

test('a raise saves its start only once Jira shows it, before the step is journalled done', async () => {
  const today = localDate(new Date(), config.timezone);
  // A raise whose edit never happened records no start.
  const failed = registerTickets();
  const jira = new FakeJira(failed);
  jira.failNext = { name: 'edit', error: { uncertain: true } };
  const first = await executor(jira, failed);
  await first.exec.raiseCovered({ ticket: 'APP-31', from: 'medium', to: 'high', alerts: [`${WEB}#14`] }, new Set());
  assert.equal(first.control.state?.dueFrom?.['APP-31'], undefined);
  // A verified raise has its start saved before its journal entry is settled.
  const tickets = registerTickets();
  const second = new FakeJira(tickets);
  const { exec, control } = await executor(second, tickets);
  const settle = control.settle.bind(control);
  control.settle = async (id, ...rest) => {
    if (id.endsWith(':APP-31:severity-high')) {
      assert.equal(control.state?.dueFrom?.['APP-31'], today);
    }
    return settle(id, ...rest);
  };
  await exec.raiseCovered({ ticket: 'APP-31', from: 'medium', to: 'high', alerts: [`${WEB}#14`] }, new Set());
  assert.equal(control.state.dueFrom['APP-31'], today);
});

test('a start that cannot be saved leaves the raise to recovery, which saves it', async () => {
  const today = localDate(new Date(), config.timezone);
  const tickets = registerTickets();
  const jira = new FakeJira(tickets);
  const { exec, control } = await executor(jira, tickets);
  const saveState = control.saveState.bind(control);
  let refused = false;
  control.saveState = async (changes) => {
    if (changes.dueFrom && !refused) {
      refused = true;
      throw Object.assign(new Error('Jira PUT property: HTTP 403'), { status: 403 });
    }
    return saveState(changes);
  };
  const raise = { ticket: 'APP-31', from: 'medium', to: 'high', alerts: [`${WEB}#14`] };
  await exec.raiseCovered(raise, new Set());
  assert.equal(raise.applied, false);
  const entry = control.journal.entries.find((item) => item.kind === 'severity');
  assert.equal(entry.status, 'uncertain');
  // A recovery whose save fails too keeps the entry pending (it is not given up like an unreadable ticket).
  const blocked = await executor(jira, tickets, { runId: 'week-2' });
  blocked.control.saveState = async (changes) => {
    if (changes.dueFrom) {
      throw Object.assign(new Error('Jira PUT property: HTTP 403'), { status: 403 });
    }
    return ControlState.prototype.saveState.call(blocked.control, changes);
  };
  await assert.rejects(blocked.exec.recover(), /fix deadline start of APP-31 not saved/);
  assert.equal(blocked.control.journal.entries.find((item) => item.id === entry.id).status, 'uncertain');
  const later = await executor(jira, tickets, { runId: 'week-3' });
  await later.exec.recover();
  assert.equal(later.control.state.dueFrom['APP-31'], today);
  assert.equal(later.control.journal.entries.find((item) => item.id === entry.id).status, 'done');
});

test('a retry of the run on a later day reports the day the reused ticket was created', async () => {
  const jira = new FakeJira();
  const { exec } = await executor(jira, []);
  const highGroup = { ...createGroup(), severity: 'high' };
  const first = {};
  await exec.create(highGroup, first);
  jira.issues.get(first.ticketKey).fields.created = '2026-11-20T10:00:00.000+0530';
  // The journal of the first attempt is lost, so the retry finds the ticket by its run label.
  const retry = await executor(jira, []);
  retry.control.journal.entries = [];
  const second = {};
  await retry.exec.create(highGroup, second);
  assert.equal(second.ticketKey, first.ticketKey);
  assert.equal(second.createdOn, '2026-11-20');
});
