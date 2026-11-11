import { OWNED_LABEL } from './reconcile.mjs';
import { SEVERITY_RANK, alertId } from './util.mjs';

/**
 * Fix deadlines for Critical/High tickets: the start date plus `dueDays` calendar days in the configured timezone.
 * The start date is the ticket's creation date, or the latest day this automation raised it into Critical/High (saved
 * in the run state as soon as the raise is verified). Days left are recomputed every run, so nothing goes stale when a
 * week is skipped.
 */
export const DEFAULT_DUE_DAYS = 15;
const DAY_MS = 864e5;
// Tickets this run changed and recorded ownership for; their state is overlaid on the collected snapshot.
const APPLIED_ACTIONS = new Set(['created', 'adopted', 'extended', 'kept', 'kept-updated']);

export const dueDays = (config) => config.dueDays ?? DEFAULT_DUE_DAYS;
export const isDueSeverity = (severity) => (SEVERITY_RANK[severity] ?? 0) >= SEVERITY_RANK.high;

/** A severity raise starts the clock only when the ticket enters Critical/High. */
export const startsClock = (from, to) => isDueSeverity(to) && !isDueSeverity(from);

/** Calendar date (YYYY-MM-DD) of `date` in `timeZone`. */
export function localDate(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** "09 Dec 2026". */
export function displayDate(day) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

export function daysLeftText(days) {
  const plural = (count) => (count === 1 ? 'day' : 'days');
  if (days > 0) {
    return `${days} ${plural(days)} left`;
  }
  return days === 0 ? 'Due today' : `Overdue by ${-days} ${plural(-days)}`;
}

/** Start and due date of a raise made today, or null when the raise does not enter Critical/High. */
export function raiseDeadline(from, to, config, now = new Date()) {
  if (!startsClock(from, to)) {
    return null;
  }
  const dueFrom = localDate(now, config.timezone);
  return { dueFrom, dueBy: addDays(dueFrom, dueDays(config)) };
}

function snapshotEntry(ticket, config, openAlerts) {
  const repository =
    ticket.ownership?.repository ?? config.repositories.find((repo) => repo.project === ticket.project)?.name ?? null;
  const owned = Object.keys(ticket.ownership?.alerts ?? {});
  return {
    key: ticket.key,
    severity: ticket.severity,
    status: ticket.status,
    statusCategory: ticket.statusCategory,
    repository,
    alerts: owned.filter((number) => openAlerts.has(alertId(repository, Number(number)))).length,
    tracked: (ticket.labels ?? []).includes(OWNED_LABEL) || Boolean(ticket.ownership),
    created: ticket.created ? localDate(new Date(ticket.created), config.timezone) : null,
  };
}

/** Applies what this run changed (created, adopted, held, raised tickets) on top of the collected snapshot. */
function overlay(entries, outcome, config, today) {
  for (const group of outcome.groups ?? []) {
    if (!group.ticketKey || !APPLIED_ACTIONS.has(group.action)) {
      continue;
    }
    const entry = entries.get(group.ticketKey) ?? {
      key: group.ticketKey,
      severity: group.severity,
      status: 'Open',
      statusCategory: 'new',
      repository: group.repository,
      created: group.createdOn ?? today,
    };
    entry.tracked = true;
    entry.alerts = group.alerts.length;
    if (group.onHold) {
      entry.status = config.holdStatus;
    }
    entries.set(group.ticketKey, entry);
  }
  // A hold or a raise is verified in Jira when it is recorded, even if a later step for the same ticket failed; both
  // happen only after the owned label is on the ticket.
  for (const group of outcome.groups ?? []) {
    const entry = entries.get(group.ticketKey);
    if (entry && (group.onHold || group.heldVerified)) {
      Object.assign(entry, { tracked: true, status: config.holdStatus });
    }
  }
  for (const raise of (outcome.severityRaises ?? []).filter((item) => item.applied)) {
    const entry = entries.get(raise.ticket);
    if (entry) {
      entry.tracked = true;
      if ((SEVERITY_RANK[raise.to] ?? 0) > (SEVERITY_RANK[entry.severity] ?? 0)) {
        entry.severity = raise.to;
      }
    }
  }
}

/** Per ticket, the latest of several start-date maps: a later raise into Critical/High starts a new clock. */
export function latestStarts(...maps) {
  const starts = {};
  for (const map of maps) {
    for (const [key, day] of Object.entries(map ?? {})) {
      if (day && (!starts[key] || day > starts[key])) {
        starts[key] = day;
      }
    }
  }
  return starts;
}

/** Start dates of the raises into Critical/High that this run applied. */
export function raiseStarts(raises) {
  const applied = (raises ?? []).filter((raise) => raise.applied && raise.dueFrom);
  return latestStarts(...applied.map((raise) => ({ [raise.ticket]: raise.dueFrom })));
}

/**
 * Open (not Done) Critical/High tickets this automation tracks, with their deadline. `dueFrom` maps tickets to the
 * day a raise into Critical/High started their clock; any other ticket starts at its creation date. `available` is
 * false when the run never read the tickets, so a failed collection is never shown as "none open".
 */
export function openHighTickets({ tickets, alerts, outcome, config, dueFrom = {}, now = new Date() }) {
  if (!tickets) {
    return { available: false, rows: [] };
  }
  const today = localDate(now, config.timezone);
  const openAlerts = new Set((alerts ?? []).map((alert) => alertId(alert.repository, alert.number)));
  const entries = new Map(tickets.map((ticket) => [ticket.key, snapshotEntry(ticket, config, openAlerts)]));
  overlay(entries, outcome, config, today);
  const rows = [...entries.values()]
    .filter((entry) => entry.tracked && entry.statusCategory !== 'done' && isDueSeverity(entry.severity))
    .map((entry) => {
      const start = dueFrom[entry.key] ?? entry.created;
      const dueDate = start ? addDays(start, dueDays(config)) : null;
      return { ...entry, dueFrom: start, dueDate, daysLeft: dueDate ? daysBetween(today, dueDate) : null };
    })
    .sort(
      (a, b) =>
        (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.key.localeCompare(b.key),
    );
  return { available: true, rows };
}

/** The start dates to keep in the run state: those of tickets still open at Critical/High (all when unknown). */
export function keptStarts(starts, openHigh) {
  if (!openHigh?.available) {
    return { ...starts };
  }
  const open = new Set(openHigh.rows.map((row) => row.key));
  return Object.fromEntries(Object.entries(starts ?? {}).filter(([key]) => open.has(key)));
}
