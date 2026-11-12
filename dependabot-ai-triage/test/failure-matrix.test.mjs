// Every Jira write of a run is interrupted in turn: a definite error, an unknown outcome before or after the write
// lands, or the runner dying just before or just after it. Retries of the same run must then reach exactly the
// state an uninterrupted run reaches: nothing duplicated, nothing missing, ownership only with everything it needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPending } from '../apply.mjs';
import { OWNERSHIP_PROPERTY } from '../lib/reconcile.mjs';
import { EL, blocked, bootstrapPlan, group, registerTickets } from './fixtures.mjs';
import { FakeJira, config, executor, severityId } from './support.mjs';

const WRITES = new Set([
  'create',
  'setProperty',
  'deleteProperty',
  'edit',
  'addLabel',
  'addComment',
  'transition',
  'link',
]);

function matrixPlan() {
  const plan = bootstrapPlan();
  plan.groups = plan.groups.filter((item) => item.operation !== 'create');
  const raise = plan.groups.find((item) => item.ticket === 'LIB-44');
  raise.updateNote = 'Scope reviewed.';
  plan.groups.push(
    group(`${EL}:blocked-new`, EL, 'create', undefined, 'medium', [108], {
      ...blocked('no-upstream-patch', 'https://github.com/advisories/GHSA-0000-0000-0008'),
      relatedTickets: ['LIB-24'],
    }),
  );
  return plan;
}

function freshJira(tickets) {
  const jira = new FakeJira(tickets);
  jira.issues.get('LIB-44').fields[config.severityField] = { id: severityId('medium') };
  return jira;
}

/** Wraps every write: `fault(name)` decides what happens to the n-th write. */
function inject(jira, plan) {
  let count = 0;
  let dead = false;
  for (const name of WRITES) {
    const original = jira[name].bind(jira);
    jira[name] = async (...args) => {
      if (dead) {
        throw Object.assign(new Error('runner stopped'), { status: 0 });
      }
      count += 1;
      if (count !== plan.at) {
        return original(...args);
      }
      if (plan.mode === 'definite') {
        throw Object.assign(new Error(`${name} rejected`), { status: 400 });
      }
      if (plan.mode === 'uncertain-before') {
        throw Object.assign(new Error(`${name} timed out`), { uncertain: true });
      }
      if (plan.mode === 'kill-before') {
        dead = true;
        throw Object.assign(new Error('runner stopped'), { status: 0 });
      }
      const result = await original(...args);
      if (plan.mode === 'uncertain-after') {
        throw Object.assign(new Error(`${name} timed out`), { uncertain: true });
      }
      dead = true;
      return result;
    };
  }
  return {
    count: () => count,
    heal() {
      dead = false;
      plan.at = -1;
    },
  };
}

async function attempt(jira, tickets, plan) {
  const { exec, control, outcome } = await executor(jira, tickets);
  outcome.groups = plan.groups.map(() => {
    return {};
  });
  await exec.recover();
  try {
    await runPending(exec, control, outcome, plan);
  } catch {
    // A stopped runner can fail anywhere; only the state left in Jira matters.
  }
  return outcome;
}

const markers = (issue) =>
  issue.comments.map((comment) => /ref (dat-[0-9a-f]+)/.exec(JSON.stringify(comment))?.[1] ?? 'unmarked').sort();

// The kind of each comment: a severity explanation made by a later run legitimately carries that run's marker.
const headings = (issue) =>
  issue.comments.map((comment) => /"type":"text","text":"([^"]+)"/.exec(JSON.stringify(comment))?.[1] ?? '').sort();

function snapshot(jira, byHeading = false) {
  const issues = [...jira.issues.values()].filter((issue) => issue.key !== config.controlIssue);
  return issues
    .map((issue) => {
      const ownership = issue.properties[OWNERSHIP_PROPERTY];
      return {
        key: issue.fields.labels.find((label) => /^dat-/.test(label)) ?? issue.key,
        labels: [...issue.fields.labels].sort(),
        severity: issue.fields[config.severityField]?.id ?? null,
        status: issue.fields.status?.name ?? null,
        // Links this ticket makes; the reverse side shown on the related ticket is not one of its own writes.
        links: (issue.fields.issuelinks ?? [])
          .flatMap((link) => (link.outwardIssue ? [link.outwardIssue.key] : []))
          .sort(),
        linkedFrom: (issue.fields.issuelinks ?? []).flatMap((link) => (link.inwardIssue ? [link.inwardIssue.key] : []))
          .length,
        comments: byHeading ? headings(issue) : markers(issue),
        owned: ownership ? Object.keys(ownership.alerts ?? {}).sort() : null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Ownership is recorded last: a ticket that owns its alerts already has every comment, link and status it needs. */
function ownershipViolations(jira, expected) {
  const wanted = new Map(expected.map((item) => [item.key, item]));
  return snapshot(jira)
    .filter((item) => item.owned && JSON.stringify(item.owned) === JSON.stringify(wanted.get(item.key)?.owned))
    .filter((item) => {
      const want = wanted.get(item.key);
      const has = (list, needed) => needed.every((value) => list.includes(value));
      return !has(item.comments, want.comments) || !has(item.links, want.links) || item.status !== want.status;
    })
    .map((item) => item.key);
}

test('every interrupted write converges to the uninterrupted result', async () => {
  const tickets = registerTickets();
  const clean = freshJira(tickets);
  const writes = inject(clean, { at: 0 });
  await attempt(clean, tickets, matrixPlan());
  const expected = snapshot(clean);
  const total = writes.count();
  assert.ok(total > 20, `expected a realistic number of writes, got ${total}`);
  const failures = [];
  for (const mode of ['definite', 'uncertain-before', 'uncertain-after', 'kill-before', 'kill-after']) {
    for (let at = 1; at <= total; at += 1) {
      const jira = freshJira(tickets);
      const faults = inject(jira, { at, mode });
      await attempt(jira, tickets, matrixPlan());
      faults.heal();
      const early = ownershipViolations(jira, expected);
      for (let retry = 0; retry < 3; retry += 1) {
        await attempt(jira, tickets, matrixPlan());
        early.push(...ownershipViolations(jira, expected));
      }
      if (early.length) {
        failures.push(
          `${mode} at write ${at}: ownership recorded before its required writes on ${[...new Set(early)]}`,
        );
      }
      const actual = snapshot(jira);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const diff = actual
          .map((item, index) => [item, expected[index]])
          .filter(([a, e]) => JSON.stringify(a) !== JSON.stringify(e))
          .map(([a, e]) => `${a?.key}: got ${JSON.stringify(a)} want ${JSON.stringify(e)}`);
        failures.push(`${mode} at write ${at}: ${actual.length}/${expected.length} issues; ${diff.join(' | ')}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('the next run finishes the follow-up writes of every interrupted action, without duplicates', async () => {
  const tickets = registerTickets();
  const clean = freshJira(tickets);
  const writes = inject(clean, { at: 0 });
  await attempt(clean, tickets, matrixPlan());
  const total = writes.count();
  const failures = [];
  for (const mode of ['definite', 'uncertain-before', 'uncertain-after', 'kill-before', 'kill-after']) {
    for (let at = 1; at <= total; at += 1) {
      const jira = freshJira(tickets);
      const faults = inject(jira, { at, mode });
      await attempt(jira, tickets, matrixPlan());
      faults.heal();
      // The next scheduled run: a new run id and, for this check, nothing newly planned.
      const { exec, control, outcome } = await executor(jira, tickets, { runId: 'next-run' });
      outcome.groups = [];
      await exec.recover();
      await runPending(exec, control, outcome, null);
      for (const issue of jira.issues.values()) {
        const found = markers(issue).filter((marker) => marker !== 'unmarked');
        if (new Set(found).size !== found.length) {
          failures.push(`${mode} at write ${at}: duplicate comment on ${issue.key}`);
        }
        const created = issue.fields.labels.some((label) => /^dat-/.test(label));
        const linked = (issue.fields.issuelinks ?? []).some((link) => link.outwardIssue?.key === 'LIB-24');
        if (created && !linked) {
          failures.push(`${mode} at write ${at}: created ${issue.key} lost its link`);
        }
        const reasoned = issue.comments.some((comment) => JSON.stringify(comment).includes('Reason for On Hold'));
        if (created && issue.fields.status?.name === 'On Hold' && !reasoned) {
          failures.push(`${mode} at write ${at}: created ${issue.key} is On Hold without its reason`);
        }
        const raised = issue.key === 'LIB-44' && issue.fields[config.severityField]?.id === severityId('high');
        const explained = issue.comments.some((comment) => JSON.stringify(comment).includes('severity raised'));
        if (raised && !explained) {
          failures.push(`${mode} at write ${at}: LIB-44 severity raised without its explanation`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a later run that plans the same tickets again never repeats a comment', async () => {
  const tickets = registerTickets();
  const updates = () => {
    return { ...matrixPlan(), groups: matrixPlan().groups.filter((item) => item.ticket) };
  };
  const clean = freshJira(tickets);
  const writes = inject(clean, { at: 0 });
  await attempt(clean, tickets, updates());
  const expected = snapshot(clean, true).filter((item) => !/^dat-/.test(item.key));
  const total = writes.count();
  const failures = [];
  for (const mode of ['definite', 'uncertain-before', 'uncertain-after', 'kill-before', 'kill-after']) {
    for (let at = 1; at <= total; at += 1) {
      const jira = freshJira(tickets);
      const faults = inject(jira, { at, mode });
      await attempt(jira, tickets, updates());
      faults.heal();
      for (const runId of ['next-run', 'week-after']) {
        const { exec, control, outcome } = await executor(jira, tickets, { runId });
        const plan = updates();
        outcome.groups = plan.groups.map(() => {
          return {};
        });
        await exec.recover();
        await runPending(exec, control, outcome, plan);
      }
      const actual = snapshot(jira, true).filter((item) => !/^dat-/.test(item.key));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const diff = actual
          .map((item, index) => [item, expected[index]])
          .filter(([a, e]) => JSON.stringify(a) !== JSON.stringify(e))
          .map(([a, e]) => `${a?.key}: got ${JSON.stringify(a)} want ${JSON.stringify(e)}`);
        failures.push(`${mode} at write ${at}: ${diff.join(' | ')}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a link that fails permanently never stops the plan and is given up after its retry', async () => {
  const tickets = registerTickets();
  const jira = freshJira(tickets);
  jira.link = async () => {
    throw Object.assign(new Error('Jira POST link: HTTP 404'), { status: 404 });
  };
  await attempt(jira, tickets, matrixPlan());
  const later = await executor(jira, tickets, { runId: 'next-run' });
  const plan = { ...matrixPlan(), groups: matrixPlan().groups.filter((item) => item.ticket === 'APP-31') };
  later.outcome.groups = plan.groups.map(() => {
    return {};
  });
  const executed = [];
  const execute = later.exec.execute.bind(later.exec);
  later.exec.execute = async (value) => {
    executed.push(value);
    return execute(value);
  };
  await later.exec.recover();
  await runPending(later.exec, later.control, later.outcome, plan);
  assert.equal(executed.length, 1);
  assert.ok(later.outcome.warnings.some((warning) => warning.code === 'abandoned'));
  const third = await executor(jira, tickets, { runId: 'week-after' });
  third.outcome.groups = [];
  await third.exec.recover();
  assert.deepEqual(third.exec.pendingWrites, []);
});
