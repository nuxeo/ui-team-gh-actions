import {
  SEVERITIES,
  SEVERITY_RANK,
  adfBullets,
  adfCode,
  adfDoc,
  adfHeading,
  adfLink,
  adfParagraph,
  adfText,
  alertId,
  clip,
  jsonBytes,
  titleCase,
} from './util.mjs';
import { daysBetween, daysLeftText, displayDate, dueDays } from './due.mjs';

const SEVERITY_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
const TEAMS_SECTION_LIMIT = 10;
// Rows per table node in the private report; a table is also split before its ADF reaches TABLE_BUDGET characters, so
// it always fits in one comment (COMMENT_BUDGET).
const REPORT_TABLE_ROWS = 25;
const TABLE_BUDGET = 20000;
const BLOCKER_LABEL = { 'no-upstream-patch': 'no patch', 'upstream-release-pending': 'waiting on upstream' };
const COMMENT_BUDGET = 28000;
// Teams webhooks reject payloads above about 28 KB, and the card is also stored in one Jira property.
const CARD_BUDGET = 24000;

const browse = (site, key) => `${site}/browse/${key}`;
const shortRepo = (name) => name.split('/')[1];

function alertLine(alert) {
  const ids = [alert.ghsa, alert.cve].filter(Boolean).join(' / ');
  const patched = alert.firstPatched ?? 'none published';
  const details = ` · ${titleCase(alert.severity)} · ${alert.package} · ${ids} · ${alert.manifest} · patched: ${patched}`;
  return [adfLink(`${shortRepo(alert.repository)}#${alert.number}`, alert.url), adfText(details)];
}

function dependentLabel(dependent) {
  const version = dependent.version ? `@${dependent.version}` : '';
  return `${dependent.name}${version} (${dependent.range})`;
}

function instanceLabel(instance) {
  const via = instance.dependents.slice(0, 2).map(dependentLabel).join(', ');
  const suffix = via ? ` ← ${via}` : '';
  return `${instance.version} at ${instance.path}${suffix}`;
}

export function instanceSummary(analysis) {
  if (!analysis) {
    return 'not collected';
  }
  if (analysis.kind === 'manifest') {
    const declared = analysis.declarations.map((item) => `${item.field}: ${item.spec}`).join(', ') || '(not declared)';
    return analysis.supported ? `declared ${declared}` : 'manifest not present on this branch';
  }
  if (!analysis.supported) {
    return analysis.reason;
  }
  const vulnerable = analysis.instances.filter((instance) => instance.vulnerable !== false);
  const shown = vulnerable.slice(0, 6).map(instanceLabel);
  const more = vulnerable.length > shown.length ? `; +${vulnerable.length - shown.length} more` : '';
  const listed = shown.join('; ') || 'none';
  return `${analysis.instances.length} resolved instance(s), ${vulnerable.length} in the vulnerable range: ${listed}${more}`;
}

function findingsSection(alerts, evidence) {
  return alerts.map((alert) => {
    const branches = Object.entries(evidence[alertId(alert.repository, alert.number)] ?? {}).map(
      ([branch, analysis]) => {
        const line = clip(`${branch}: ${instanceSummary(analysis)}`, 1500);
        return adfText(`\n${line}`);
      },
    );
    return [...alertLine(alert), ...branches];
  });
}

function blockerLines(blocker) {
  return [
    `Blocker: ${blocker.reason}`,
    `Upstream reference: ${blocker.upstreamRef}`,
    `Available mitigation: ${blocker.mitigation}`,
    `Resume / recheck when: ${blocker.recheck}`,
  ];
}

const dueSentence = (due, origin, prefix = '') =>
  `Fix due by ${displayDate(due.dueBy)} (${prefix}${daysBetween(due.dueFrom, due.dueBy)} days from ${origin}).`;

export function ticketDescription({ group, alerts, evidence, config, runId, due }) {
  const branches = config.repositoryConfig(group.repository).branches.join(', ');
  const severityNote =
    `Defect Severity is ${titleCase(group.severity)}: the highest current GitHub severity below. ` +
    'Each finding keeps its own severity.';
  const footer =
    `Created by Dependabot AI triage run ${runId} (remediation ${group.remediationId}). ` +
    'Alert ownership is stored in the issue property "dependabot-ai-triage-ownership"; editing this ' +
    'description does not change which alerts this ticket owns.';
  return adfDoc([
    adfHeading('Remediation'),
    adfParagraph(adfText(group.remediation)),
    ...(group.blocker ? [adfHeading('Blocker'), adfBullets(blockerLines(group.blocker))] : []),
    adfHeading(`Findings (${alerts.length})`),
    adfParagraph(adfText(severityNote)),
    due ? adfParagraph(adfText(dueSentence(due, 'creation', 'Critical/High: '))) : null,
    adfBullets(findingsSection(alerts, evidence)),
    adfHeading('Grouping rationale'),
    adfParagraph(adfText(group.rationale)),
    adfHeading('Acceptance criteria and required validation'),
    adfBullets(group.acceptanceCriteria),
    adfHeading('Scope'),
    adfParagraph(adfText(`Repository: ${group.repository}. Supported branches: ${branches}.`)),
    adfParagraph(adfText(footer)),
  ]);
}

export function extendComment({ group, added, evidence, runId, marker }) {
  const extended = added.length > 0;
  const severity = `Highest current GitHub severity of the findings this ticket owns: ${titleCase(group.severity)}.`;
  return adfDoc([
    adfHeading(extended ? 'Dependabot triage: scope extended' : 'Dependabot triage: finding update'),
    adfParagraph(adfText(group.updateNote ?? group.rationale)),
    extended ? adfBullets(findingsSection(added, evidence)) : null,
    adfParagraph(adfText(`${severity} Run ${runId} (ref ${marker}).`)),
  ]);
}

function priorityLine(priority) {
  if (!priority) {
    return '';
  }
  return priority.from
    ? ` Priority raised from ${priority.from} to ${priority.to}.`
    : ` Priority set to ${priority.to}.`;
}

export function severityComment({ raise, runId, marker }) {
  const from = raise.from ? titleCase(raise.from) : 'unset';
  const text =
    `GitHub now reports ${titleCase(raise.to)} for ${raise.alerts.join(', ')}. ` +
    `Defect Severity raised from ${from} to ${titleCase(raise.to)}.` +
    priorityLine(raise.priority) +
    (raise.dueBy ? ` ${dueSentence(raise, 'this raise')}` : '') +
    ` Run ${runId} (ref ${marker}).`;
  return adfDoc([adfHeading('Dependabot triage: severity raised'), adfParagraph(adfText(text))]);
}

export function holdComment({ group, runId, marker }) {
  const note =
    'Severity remains unchanged. No risk acceptance or alert dismissal is implied. ' +
    `Set by Dependabot AI triage run ${runId} (ref ${marker}).`;
  return adfDoc([
    adfHeading('Reason for On Hold'),
    adfBullets(blockerLines(group.blocker)),
    adfParagraph(adfText(note)),
  ]);
}

function countLine(bySeverity) {
  return [...SEVERITIES]
    .reverse()
    .map((severity) => `${SEVERITY_ICON[severity]} ${bySeverity[severity] ?? 0} ${titleCase(severity)}`)
    .join(' · ');
}

const ENTRY_BUDGET = 6000;
const LIST_BUDGET = 9000;

// Lists are split into several nodes by size, so a long report can be divided across comments and no single
// node can outgrow a comment.
function chunks(items, size = 10) {
  const nodes = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    const itemLength = JSON.stringify(item).length;
    if (current.length && (current.length >= size || length + itemLength > LIST_BUDGET)) {
      nodes.push(adfBullets(current));
      current = [];
      length = 0;
    }
    current.push(item);
    length += itemLength;
  }
  if (current.length) {
    nodes.push(adfBullets(current));
  }
  return nodes;
}

const listSection = (title, items, size) => (items.length ? [adfHeading(title), ...chunks(items, size)] : []);

function sourceLine(repo) {
  const status = repo.complete ? `${repo.open} alert(s), ${repo.pages} page(s), complete` : 'FAILED';
  return `${shortRepo(repo.name)}: ${status}`;
}

function summaryLine(outcome) {
  const { counts } = outcome;
  const label = outcome.firstReconciliation ? 'untriaged at first reconciliation' : 'newly untriaged';
  // Without a validated plan the number of untriaged findings is unknown, not zero.
  const untriaged = outcome.planDetermined
    ? countLine(outcome.newBySeverity)
    : `not determined (no validated plan; ${counts.alerts - counts.covered} alert(s) awaiting triage)`;
  return (
    `${counts.alerts} open alert(s) (${counts.uniqueAdvisories} advisories) · ${counts.covered} already covered · ` +
    `${label}: ${untriaged}`
  );
}

const ACTION_LABEL = {
  'proposed create': 'to create',
  created: 'created',
  'proposed extend': 'to extend',
  extended: 'extended',
  'proposed adopt': 'existing ticket; ownership to record',
  adopted: 'existing ticket; ownership recorded',
  'proposed keep': 'finding changed',
  'kept-updated': 'finding changed; note added',
  kept: 'existing ticket',
};

function isReportable(group) {
  // A hold this run verified is news even when the ticket's other steps failed or changed nothing else.
  if (group.heldVerified) {
    return true;
  }
  return group.action !== 'kept' && (group.action !== 'proposed keep' || Boolean(group.updateNote));
}

function raiseText(raise, mode) {
  const from = !raise.from || raise.from === 'unset' ? 'unset' : titleCase(raise.from);
  const verb = raise.applied ? 'severity raised' : mode === 'automatic' ? 'severity not raised' : 'severity to raise';
  return `${verb} from ${from} to ${titleCase(raise.to)}`;
}

const dueLine = (row, origin) =>
  `Due: ${displayDate(row.dueDate)} (${daysBetween(row.dueFrom, row.dueDate)} days from ${origin})`;

/** The deadline line of a ticket whose clock this run started: by creating it or by raising it to Critical/High. */
function startedDue(context, key, created) {
  const row = context.due.get(key);
  if (!row?.dueDate) {
    return null;
  }
  if (created) {
    return dueLine(row, 'creation');
  }
  const raise = context.raises.get(key);
  return raise?.applied && raise.dueFrom && raise.dueFrom === row.dueFrom ? dueLine(row, 'the severity raise') : null;
}

/** One line for recorded ownership; full detail only where ticket scope is created or extended. */
function groupEntry(group, site, context) {
  const target = group.ticketKey ? adfLink(group.ticketKey, browse(site, group.ticketKey)) : adfText('New ticket');
  const alerts = group.alerts.length === 1 ? `alert ${group.alerts[0]}` : `alerts ${group.alerts.join(', ')}`;
  const blocked = group.kind === 'blocked' ? ` · blocked${group.heldVerified ? '; put On Hold' : ''}` : '';
  const raise = context.raises.get(group.ticketKey);
  const raised = raise ? ` · ${raiseText(raise, context.mode)}` : '';
  const head = ` · ${ACTION_LABEL[group.action] ?? group.action}${raised} · ${titleCase(group.severity)}${blocked} · ${shortRepo(
    group.repository,
  )} · ${alerts}`;
  const due = group.ticketKey ? startedDue(context, group.ticketKey, group.action === 'created') : null;
  if (!['create', 'extend'].includes(group.operation)) {
    return [target, adfText([head, due].filter(Boolean).join('\n'))];
  }
  const lines = [head, group.summary ?? group.updateNote ?? '', `Fix: ${group.remediation ?? group.updateNote ?? '-'}`];
  lines.push(`Why: ${group.rationale}`);
  if (group.blocker) {
    lines.push(`Blocked by: ${group.blocker.reason} Recheck: ${group.blocker.recheck}`);
  }
  if (group.acceptanceCriteria) {
    lines.push(`Done when: ${group.acceptanceCriteria.join(' | ')}`);
  }
  lines.push(due);
  return [target, adfText(clip(lines.filter(Boolean).join('\n'), ENTRY_BUDGET))];
}

/** Severity changes of tickets that have no other entry in this report. */
function raiseEntries(outcome, site, context, listed) {
  return outcome.severityRaises
    .filter((raise) => !listed.has(raise.ticket))
    .map((raise) => {
      const due = startedDue(context, raise.ticket, false);
      const text = [` · ${raiseText(raise, context.mode)} · ${raise.alerts.join(', ')}`, due]
        .filter(Boolean)
        .join('\n');
      return [adfLink(raise.ticket, browse(site, raise.ticket)), adfText(text)];
    });
}

function ticketEntries(outcome, config) {
  const context = {
    mode: outcome.mode,
    raises: new Map(outcome.severityRaises.map((raise) => [raise.ticket, raise])),
    due: new Map((outcome.openHigh?.rows ?? []).map((row) => [row.key, row])),
  };
  const groups = outcome.groups.filter(isReportable);
  const listed = new Set(groups.map((group) => group.ticketKey).filter(Boolean));
  return [
    ...groups.map((group) => groupEntry(group, config.jiraSite, context)),
    ...raiseEntries(outcome, config.jiraSite, context, listed),
  ];
}

function adfCell(type, content) {
  return { type, attrs: {}, content: [adfParagraph(...content)] };
}

function adfTable(headers, rows) {
  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [
      { type: 'tableRow', content: headers.map((title) => adfCell('tableHeader', [adfText(title)])) },
      ...rows.map((row) => {
        return {
          type: 'tableRow',
          content: row.map((item) => adfCell('tableCell', [typeof item === 'string' ? adfText(item) : item])),
        };
      }),
    ],
  };
}

/** The full open Critical/High list, with repository, owned alerts and the start of each deadline. */
function openHighSection(outcome, config) {
  const open = outcome.openHigh;
  if (!open?.available) {
    return [adfHeading('Open Critical / High tickets'), adfParagraph(adfText('Not available (scan incomplete).'))];
  }
  if (!open.rows.length) {
    return [
      adfHeading('Open Critical / High tickets · 0'),
      adfParagraph(adfText('No Critical or High security tickets are in an open state.')),
    ];
  }
  const headers = ['Ticket', 'Severity', 'Status', 'Repository', 'Alerts', 'Due from', 'Due date', 'Days left'];
  const rows = open.rows.map((row) => [
    adfLink(row.key, browse(config.jiraSite, row.key)),
    titleCase(row.severity),
    row.status,
    row.repository ? shortRepo(row.repository) : '-',
    String(row.alerts ?? 0),
    row.dueFrom ? displayDate(row.dueFrom) : '-',
    row.dueDate ? displayDate(row.dueDate) : '-',
    row.daysLeft === null ? '-' : daysLeftText(row.daysLeft),
  ]);
  // Split by size as well as count, so one table node always fits in a comment.
  const tables = [];
  let current = [];
  for (const row of rows) {
    if (
      current.length &&
      (current.length >= REPORT_TABLE_ROWS ||
        JSON.stringify(adfTable(headers, [...current, row])).length > TABLE_BUDGET)
    ) {
      tables.push(adfTable(headers, current));
      current = [];
    }
    current.push(row);
  }
  tables.push(adfTable(headers, current));
  const note =
    `Due date = "Due from" + ${dueDays(config)} calendar days (${config.timezone}). "Due from" is the creation date, ` +
    'or the date this automation raised the ticket to Critical/High.';
  return [adfHeading(`Open Critical / High tickets · ${rows.length}`), ...tables, adfParagraph(adfText(note))];
}

function attentionLines(outcome) {
  return [
    ...outcome.failures.map((failure) => `Failure: ${failure}`),
    ...outcome.needsReview.map(
      (item) =>
        `Needs review: ${alertId(item.repository, item.alert)} · candidate ${item.candidateTicket} · ${item.missingEvidence}`,
    ),
    ...outcome.closedMismatches
      .filter((item) => item.isNew)
      .map((item) => `Closed ticket, open alert: ${item.id} is owned only by ${item.tickets.join(', ')}`),
    ...outcome.ambiguous.map((item) => `Ambiguous: ${item.id} is recorded on ${item.tickets.join(', ')}`),
    ...outcome.cleared
      .filter((item) => item.isNew)
      .map((item) => `Alert closed on GitHub: ${item.id} (${item.state}) · ${item.tickets.join(', ')}`),
    ...outcome.warnings.map((warning) => `Note: ${warning.message}`),
    ...outcome.actions
      .filter((action) => action.status === 'failed' || action.status === 'uncertain')
      .map((action) => `Write ${action.status}: ${action.kind} ${action.target ?? ''} ${action.detail ?? ''}`),
  ];
}

/** Clean weeks post no comment: the hidden state and the Teams message are enough. */
export function reportNeeded(outcome) {
  return (
    !outcome.complete ||
    outcome.validationErrors.length > 0 ||
    outcome.groups.some(isReportable) ||
    outcome.severityRaises.length > 0 ||
    // The card shows part of the open Critical/High list and links here for the rest.
    (outcome.openHigh?.rows.length ?? 0) > TEAMS_SECTION_LIMIT ||
    attentionLines(outcome).length > 0
  );
}

function splitDocuments(sections) {
  const documents = [[]];
  for (const node of sections) {
    const current = documents.at(-1);
    if (current.length && JSON.stringify([...current, node]).length > COMMENT_BUDGET) {
      documents.push([node]);
    } else {
      current.push(node);
    }
  }
  return documents.map((content, index) => {
    const part = documents.length > 1 ? [adfParagraph(adfText(`Part ${index + 1}/${documents.length}`))] : [];
    return adfDoc([...part, ...content]);
  });
}

/** Short private run report for the control issue. Returns one or more ADF documents. */
export function runReport(outcome, config) {
  const status = outcome.complete ? 'complete' : 'INCOMPLETE';
  const rejected = outcome.validationErrors.length
    ? [
        adfHeading('Plan rejected by the validator; nothing was applied'),
        adfCode(
          clip(outcome.validationErrors.map((error) => `${error.code}: ${error.message}`).join('\n'), 6000),
          'text',
        ),
      ]
    : [];
  return splitDocuments([
    adfHeading(`Dependabot triage ${outcome.mode} · ${status} · run ${outcome.runId}`, 3),
    adfParagraph(adfText(`Sources: ${outcome.repositories.map(sourceLine).join(' · ')}`)),
    adfParagraph(adfText(summaryLine(outcome))),
    ...listSection('Tickets', ticketEntries(outcome, config), 5),
    ...openHighSection(outcome, config),
    ...listSection('Needs attention', attentionLines(outcome)),
    ...rejected,
  ]);
}

function istTimestamp(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

const block = (value, extra = {}) => {
  return { type: 'TextBlock', text: value, wrap: true, ...extra };
};

function limited(items, render, controlUrl) {
  const blocks = items.slice(0, TEAMS_SECTION_LIMIT).flatMap(render);
  if (items.length > TEAMS_SECTION_LIMIT) {
    const more = `+${items.length - TEAMS_SECTION_LIMIT} more in the [full report](${controlUrl}).`;
    blocks.push(block(more, { isSubtle: true }));
  }
  return blocks;
}

/** "1 High finding needs attention." / "2 Critical and 1 High findings need attention." (zero counts omitted). */
export function attentionText(bySeverity) {
  const parts = ['critical', 'high']
    .filter((severity) => bySeverity[severity])
    .map((severity) => `${bySeverity[severity]} ${titleCase(severity)}`);
  const total = (bySeverity.critical ?? 0) + (bySeverity.high ?? 0);
  return total === 1
    ? `${parts.join(' and ')} finding needs attention.`
    : `${parts.join(' and ')} findings need attention.`;
}

// The count line already says how many of each severity are new; only Critical/High add a call to action.
function findingBlocks(outcome) {
  const fresh = outcome.newBySeverity;
  const label = outcome.firstReconciliation ? 'Untriaged findings (first reconciliation)' : 'New findings';
  const blocks = [block(`**${label}:** ${countLine(fresh)}`)];
  if (fresh.critical || fresh.high) {
    blocks.push(block(`⚠️ **${attentionText(fresh)}**`, { color: 'Attention' }));
  }
  return blocks;
}

const cell = (text, extra = {}) => {
  return { type: 'TableCell', items: [block(text, extra)] };
};

/** `headers`: [title, relative width]; each row: { cells: [text | { text, extra }], style? }. */
function table(headers, rows) {
  return {
    type: 'Table',
    firstRowAsHeader: true,
    showGridLines: true,
    columns: headers.map(([, width]) => {
      return { width };
    }),
    rows: [
      { type: 'TableRow', cells: headers.map(([title]) => cell(title, { weight: 'Bolder' })) },
      ...rows.map((row) => {
        return {
          type: 'TableRow',
          ...(row.style ? { style: row.style } : {}),
          cells: row.cells.map((item) => (typeof item === 'string' ? cell(item) : cell(item.text, item.extra))),
        };
      }),
    ],
  };
}

/** A titled table limited to the section size; the remaining rows are in the full report. */
function tableSection(title, headers, rows, controlUrl) {
  if (!rows.length) {
    return [];
  }
  const shown = rows.slice(0, TEAMS_SECTION_LIMIT);
  const blocks = [block(`**${title} · ${rows.length}**`, { separator: true }), table(headers, shown)];
  if (rows.length > shown.length) {
    blocks.push(block(`+${rows.length - shown.length} more in the [full report](${controlUrl}).`, { isSubtle: true }));
  }
  return blocks;
}

const ticketLink = (config, key) => `[${key}](${browse(config.jiraSite, key)})`;
const higher = (a, b) => ((SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function createdStatus(group, config) {
  if (group.kind !== 'blocked') {
    return 'Open';
  }
  const reason = BLOCKER_LABEL[group.blocker?.type] ?? 'blocked';
  return `${group.onHold ? config.holdStatus : 'Blocked, not On Hold'} (${reason})`;
}

function updateChange(group) {
  const changes = [];
  if (group.action === 'adopted') {
    changes.push('Now tracked');
  } else if (group.action === 'extended') {
    changes.push(group.added ? `${plural(group.added, 'alert')} added` : 'Scope extended');
  } else if (group.action === 'kept-updated') {
    changes.push(
      group.previousKind === 'blocked' && group.kind === 'actionable' ? 'Patch now available' : 'Update posted',
    );
  }
  if (group.heldVerified) {
    changes.push(changes.length ? 'put On Hold' : 'Put On Hold');
  }
  return changes;
}

const raiseChange = (raise) =>
  !raise.from || raise.from === 'unset' ? 'Severity set' : `Severity raised from ${titleCase(raise.from)}`;

/** One row per ticket this run changed; a ticket with several changes lists them together. */
function updatedRows(outcome) {
  const rows = new Map();
  const row = (key, severity) => {
    const current = rows.get(key) ?? { key, severity, changes: [] };
    current.severity = higher(current.severity, severity);
    rows.set(key, current);
    return current;
  };
  const updates = ['extended', 'kept-updated', 'adopted'];
  const changed = (item) => item.action !== 'created' && (updates.includes(item.action) || item.heldVerified);
  for (const group of outcome.groups.filter(changed)) {
    row(group.ticketKey, group.severity).changes.push(...updateChange(group));
  }
  for (const raise of outcome.severityRaises.filter((item) => item.applied)) {
    row(raise.ticket, raise.to).changes.push(raiseChange(raise));
  }
  return [...rows.values()];
}

function ticketTables(outcome, config, controlUrl) {
  const created = outcome.groups
    .filter((group) => group.action === 'created')
    .map((group) => {
      return {
        cells: [ticketLink(config, group.ticketKey), titleCase(group.severity), createdStatus(group, config)],
      };
    });
  const updated = updatedRows(outcome).map((item) => {
    return { cells: [ticketLink(config, item.key), titleCase(item.severity), item.changes.join(' · ')] };
  });
  return [
    tableSection(
      'Tickets created',
      [
        ['Ticket', 2],
        ['Severity', 1],
        ['Status', 2],
      ],
      created,
      controlUrl,
    ),
    tableSection(
      'Tickets updated',
      [
        ['Ticket', 2],
        ['Severity', 1],
        ['Change', 3],
      ],
      updated,
      controlUrl,
    ),
  ];
}

/** The standing list of open Critical/High tickets and their fix deadline; always shown. */
function openHighBlocks(outcome, config, controlUrl) {
  const open = outcome.openHigh;
  if (!open?.available) {
    return [block('**Open Critical / High tickets:** not available (scan incomplete).', { separator: true })];
  }
  if (!open.rows.length) {
    return [
      block('**Open Critical / High tickets · 0**', { separator: true }),
      block('No Critical or High security tickets are in an open state.'),
    ];
  }
  const rows = open.rows.map((item) => {
    const overdue = item.daysLeft !== null && item.daysLeft < 0;
    const left = item.daysLeft === null ? '—' : daysLeftText(item.daysLeft);
    return {
      ...(overdue ? { style: 'attention' } : {}),
      cells: [
        ticketLink(config, item.key),
        titleCase(item.severity),
        item.status,
        item.dueDate ? displayDate(item.dueDate) : '—',
        overdue ? { text: `⚠️ ${left}`, extra: { color: 'Attention', weight: 'Bolder' } } : left,
      ],
    };
  });
  return tableSection(
    'Open Critical / High tickets',
    [
      ['Ticket', 2],
      ['Severity', 1],
      ['Status', 2],
      ['Due date', 2],
      ['Days left', 2],
    ],
    rows,
    controlUrl,
  );
}

function reviewLines(outcome) {
  return [
    ...outcome.needsReview.map(
      (item) =>
        `${shortRepo(item.repository)}#${item.alert} · candidate ${item.candidateTicket}: ${item.missingEvidence}`,
    ),
    ...outcome.closedMismatches
      .filter((item) => item.isNew)
      .map((item) => `${shortRepo(item.id)} is still open but ${item.tickets.join(', ')} is closed.`),
    ...(outcome.ambiguous ?? []).map(
      (item) =>
        `${shortRepo(item.id)} is recorded on several open tickets (${item.tickets.join(', ')}); keep one owner.`,
    ),
  ];
}

/** Teams Adaptive Card: findings, this run's ticket changes, items to review and the open Critical/High tickets. */
export function teamsCard(outcome, config, now = new Date()) {
  const controlUrl = browse(config.jiraSite, config.controlIssue);
  // Sections are kept or dropped whole when the card is trimmed, so a table never loses its title or rows.
  const sections = [[block(`**Dependabot triage · ${istTimestamp(now, config.timezone)} IST**`, { size: 'Medium' })]];
  if (!outcome.complete) {
    sections.push([
      block('⚠️ **Dependabot triage — scan incomplete**', { color: 'Attention' }),
      ...outcome.failures.slice(0, 10).map((failure) => block(`• ${clip(failure, 300)}`)),
    ]);
  }
  const newTotal = SEVERITIES.reduce((sum, severity) => sum + (outcome.newBySeverity[severity] ?? 0), 0);
  const review = reviewLines(outcome);
  // The findings result is always stated, whatever else changed; an incomplete scan never claims "no new findings".
  const findings = [];
  if (newTotal > 0) {
    findings.push(...findingBlocks(outcome));
  } else if (outcome.complete) {
    findings.push(block('No new untriaged Dependabot findings were identified.'));
  }
  if (outcome.complete && outcome.counts) {
    const { alerts, covered } = outcome.counts;
    findings.push(
      block(`${alerts} open alert(s) · ${covered} already tracked on tickets before this run`, { isSubtle: true }),
    );
  }
  sections.push(findings, ...ticketTables(outcome, config, controlUrl));
  if (review.length) {
    sections.push([
      block(`**Needs review · ${review.length}**`, { separator: true }),
      ...limited(review, (line) => [block(`• ${clip(line, 300)}`)], controlUrl),
    ]);
  }
  const repositories = outcome.repositories.map((item) => shortRepo(item.name)).join(', ');
  const footer = block(`Repositories: ${repositories} · [Full report](${controlUrl}) · Run ID: ${outcome.runId}`, {
    isSubtle: true,
    separator: true,
    size: 'Small',
  });
  const body = sections.filter((section) => section.length);
  return cardEnvelope(fitCard(body, openHighBlocks(outcome, config, controlUrl), footer, controlUrl));
}

/**
 * Drops whole trailing sections of the body until the card fits its byte budget; they stay in the full report. The
 * first section (the header) and the open Critical/High list (`tail`) are always kept.
 */
function fitCard(sections, tail, footer, controlUrl) {
  const kept = [...sections];
  let omitted = 0;
  const notice = () => block(`${omitted} more section(s) are in the [full report](${controlUrl}).`, { isSubtle: true });
  const blocks = () => [...kept.flat(), ...(omitted ? [notice()] : []), ...tail, footer];
  while (kept.length > 1 && jsonBytes(cardEnvelope(blocks())) > CARD_BUDGET) {
    kept.pop();
    omitted += 1;
  }
  return blocks();
}

function cardEnvelope(body) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          type: 'AdaptiveCard',
          version: '1.5',
          $schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
          body,
        },
      },
    ],
  };
}
