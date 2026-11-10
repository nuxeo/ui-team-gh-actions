import { jsonBytes, mapSequential, shortHash } from './util.mjs';

/**
 * Names what a comment says about which ticket, never which run wrote it: recovery proves a write by its marker,
 * and a later run that would post the same comment finds it and does not repeat it.
 */
export function commentMarker(...parts) {
  return `dat-${shortHash(parts)}`;
}

// A blocker reason is identified by everything it says, so an updated reason, mitigation or recheck is posted.
export const holdMarker = (key, blocker) =>
  commentMarker(
    'hold',
    key,
    blocker?.type,
    blocker?.upstreamRef ?? null,
    blocker?.reason,
    blocker?.mitigation,
    blocker?.recheck,
  );

export const holdCommentId = (runId, key, blocker) => `${runId}:${key}:hold-comment:${holdMarker(key, blocker)}`;

export const STATE_PROPERTY = 'dependabot-ai-triage-state';
export const JOURNAL_PROPERTY = 'dependabot-ai-triage-journal';
// Alerts already reported as closed on GitHub: an index property plus shards of exact per-repository ranges.
export const CLEARED_PROPERTY = 'dependabot-ai-triage-cleared';
// Jira issue properties are limited to 32 768 bytes.
const PROPERTY_BUDGET = 28000;
// One property per run (`<prefix>-<runId>`) so a later run never overwrites a card awaiting a retried delivery.
export const CARD_PROPERTY = 'dependabot-ai-triage-teams-card';
// GitHub allows re-running a workflow run for 30 days; delivery records must outlive that window.
const RETRY_WINDOW_MS = 30 * 864e5;
const LOCK_STALE_HOURS = 6;
const JOURNAL_BUDGET = 28000;
// `abandoned`: a follow-up write that failed permanently or too often; reported once, never retried.
const RESOLVED = new Set(['done', 'failed', 'not-applied', 'abandoned']);
// Follow-up writes that must eventually happen: while they definitely did not, they are replayed and never pruned.
export const RETRIED = new Set(['link', 'severity-comment', 'hold-comment']);
const retryPending = (entry) => RETRIED.has(entry.kind) && ['failed', 'not-applied'].includes(entry.status);

/** The queue item that replays a follow-up write under its own journal id. */
export function retryItem(entry) {
  const { recovery } = entry;
  if (entry.kind === 'link') {
    return { id: entry.id, from: recovery.from, to: recovery.to };
  }
  const payload = entry.kind === 'hold-comment' ? { blocker: recovery.blocker } : { raise: recovery.raise };
  return { id: entry.id, kind: entry.kind, key: recovery.key, ...payload };
}

/**
 * Writes that must follow a completed action: the links of a created ticket, the reason of an On Hold transition
 * and the explanation of a raised severity. Their ids match the ones the executor uses when it makes them directly.
 */
export function followUps(entry) {
  const key = entry.result?.key ?? entry.recovery?.key;
  if (entry.status !== 'done' || !key) {
    return [];
  }
  const items = [];
  if (entry.kind === 'create') {
    for (const to of entry.recovery?.links ?? []) {
      items.push({ id: `${entry.runId}:${key}:link:${to}`, from: key, to });
    }
  }
  if (entry.kind === 'hold' && entry.recovery?.blocker) {
    items.push({
      id: holdCommentId(entry.runId, key, entry.recovery.blocker),
      kind: 'hold-comment',
      key,
      blocker: entry.recovery.blocker,
    });
  }
  if (entry.result.raise && !RETRIED.has(entry.kind)) {
    items.push({ id: `${entry.id}:severity-comment`, kind: 'severity-comment', key, raise: entry.result.raise });
  }
  return items;
}

export class LockHeldError extends Error {}

/** Property names of one generation of closure-history shards. */
function shardNames(generation, count) {
  return Array.from({ length: count }, (_, i) => `${CLEARED_PROPERTY}-${generation}-${i}`);
}

function splitId(id) {
  const index = id.lastIndexOf('#');
  return [id.slice(0, index), Number(id.slice(index + 1))];
}

/** Exact membership: closures are kept as sorted, merged [start, end] ranges per repository. */
export function isClearedReported(record, id) {
  const [repository, number] = splitId(id);
  return (record?.repositories?.[repository] ?? []).some(([start, end]) => number >= start && number <= end);
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}

export function addCleared(record, ids) {
  const next = { repositories: structuredClone(record?.repositories ?? {}) };
  for (const id of ids) {
    const [repository, number] = splitId(id);
    next.repositories[repository] = mergeRanges([...(next.repositories[repository] ?? []), [number, number]]);
  }
  return next;
}

/** Splits a closure record into parts that each fit in one Jira issue property. */
export function shardCleared(record, budget = PROPERTY_BUDGET) {
  const shards = [];
  let current = { repositories: {} };
  for (const [repository, ranges] of Object.entries(record.repositories)) {
    for (const range of ranges) {
      const candidate = structuredClone(current);
      candidate.repositories[repository] = [...(candidate.repositories[repository] ?? []), range];
      if (jsonBytes(candidate) > budget && Object.keys(current.repositories).length) {
        shards.push(current);
        current = { repositories: { [repository]: [range] } };
      } else {
        current = candidate;
      }
    }
  }
  shards.push(current);
  return shards;
}

/** Run state kept on the private control issue (Jira issue properties are not shown in the UI). */
export class ControlState {
  constructor(jira, issueKey) {
    this.jira = jira;
    this.issueKey = issueKey;
    this.state = null;
    this.journal = null;
  }

  async load() {
    this.state = await this.jira.property(this.issueKey, STATE_PROPERTY);
    this.journal = (await this.jira.property(this.issueKey, JOURNAL_PROPERTY)) ?? { schemaVersion: 1, entries: [] };
    return this.state;
  }

  async saveState(changes) {
    const next = { schemaVersion: 1, ...this.state, ...changes };
    if (jsonBytes(next) > PROPERTY_BUDGET) {
      throw new Error('Run state would exceed the Jira property size limit; it was not saved.');
    }
    this.state = next;
    await this.jira.setProperty(this.issueKey, STATE_PROPERTY, this.state);
  }

  /**
   * Best-effort cross-run lock. The workflow concurrency group is the primary guard; this protects
   * against a manual run from another ref or a stuck run whose job was cancelled mid-write.
   */
  async acquireLock(runId, now = new Date()) {
    const lock = this.state?.lock;
    if (lock && lock.runId !== runId) {
      const ageHours = (now.getTime() - Date.parse(lock.acquiredAt)) / 3.6e6;
      if (ageHours < LOCK_STALE_HOURS) {
        throw new LockHeldError(`Run ${lock.runId} holds the triage lock (acquired ${lock.acquiredAt}).`);
      }
    }
    await this.saveState({ lock: { runId, acquiredAt: now.toISOString() } });
    const verified = await this.jira.property(this.issueKey, STATE_PROPERTY);
    if (verified?.lock?.runId !== runId) {
      throw new LockHeldError('Another run replaced the triage lock.');
    }
  }

  async releaseLock(runId) {
    await this.load();
    if (this.state?.lock?.runId === runId) {
      await this.saveState({ lock: null });
    }
  }

  /** Keeps the Teams card of a run so a retried delivery sends exactly what that run reported. */
  storeCard(runId, card) {
    const stored = { runId, card };
    if (jsonBytes(stored) > PROPERTY_BUDGET) {
      throw new Error('Teams card would exceed the Jira property size limit; it was not stored or sent.');
    }
    return this.jira.setProperty(this.issueKey, `${CARD_PROPERTY}-${runId}`, stored);
  }

  async storedCard(runId) {
    const stored = await this.jira.property(this.issueKey, `${CARD_PROPERTY}-${runId}`);
    return stored?.runId === runId ? stored.card : null;
  }

  /** Best effort: a delivered card is no longer needed. */
  async discardCard(runId) {
    try {
      await this.jira.deleteProperty(this.issueKey, `${CARD_PROPERTY}-${runId}`);
    } catch {
      // A leftover card is harmless; it is only read for a retry of the same run.
    }
  }

  /** Reserved writes, plus unknown outcomes that can be reconciled from Jira (every Jira write records how). */
  pending() {
    return this.journal.entries.filter(
      (entry) => entry.status === 'reserved' || (entry.status === 'uncertain' && entry.recovery),
    );
  }

  completed() {
    return this.journal.entries.filter((entry) => entry.status === 'done');
  }

  /** Follow-up writes that definitely did not happen yet; replayed under their own ids until done. */
  retryable() {
    return this.journal.entries.filter((entry) => retryPending(entry) && entry.recovery);
  }

  /** Closure history: an index property names how many shard properties hold the ranges. */
  async loadCleared() {
    const index = await this.jira.property(this.issueKey, CLEARED_PROPERTY);
    const names = shardNames(index?.generation ?? 0, index?.shards ?? 0);
    const parts = await Promise.all(names.map((name) => this.jira.property(this.issueKey, name)));
    const record = { repositories: {} };
    for (const [repository, ranges] of parts.flatMap((part) => Object.entries(part?.repositories ?? {}))) {
      record.repositories[repository] = mergeRanges([...(record.repositories[repository] ?? []), ...ranges]);
    }
    return record;
  }

  /**
   * Adds newly reported closures. A new generation of shards is written in full before the index switches to it,
   * so an interrupted save leaves the previous generation intact and readable; the old one is removed afterwards.
   */
  async saveCleared(ids) {
    const index = await this.jira.property(this.issueKey, CLEARED_PROPERTY);
    const previous = shardNames(index?.generation ?? 0, index?.shards ?? 0);
    const record = addCleared(await this.loadCleared(), ids);
    const shards = shardCleared(record);
    const generation = (index?.generation ?? 0) + 1;
    const names = shardNames(generation, shards.length);
    await mapSequential(shards, (shard, i) => this.jira.setProperty(this.issueKey, names[i], shard));
    await this.jira.setProperty(this.issueKey, CLEARED_PROPERTY, {
      schemaVersion: 3,
      generation,
      shards: shards.length,
    });
    await mapSequential(previous, async (name) => {
      try {
        await this.jira.deleteProperty(this.issueKey, name);
      } catch {
        // A leftover old shard is never read again; removing it is housekeeping only.
      }
    });
    return record;
  }

  find(id) {
    return this.journal.entries.find((entry) => entry.id === id);
  }

  has(id) {
    return this.journal.entries.some((entry) => entry.id === id);
  }

  async persistJournal() {
    // Keep the property under Jira's size limit by dropping the oldest resolved entries. Reserved and uncertain
    // entries are kept: they are what stops an interrupted write (or Teams send) from being repeated.
    const prunedCards = [];
    while (jsonBytes(this.journal) > JOURNAL_BUDGET) {
      const index = this.journal.entries.findIndex((entry) => this.prunable(entry));
      if (index < 0) {
        throw new Error('Action journal is full of unresolved writes; manual reconciliation required.');
      }
      const [pruned] = this.journal.entries.splice(index, 1);
      if (pruned.kind === 'teams') {
        prunedCards.push(pruned.runId);
      }
    }
    await this.jira.setProperty(this.issueKey, JOURNAL_PROPERTY, this.journal);
    await mapSequential(prunedCards, (runId) => this.discardCard(runId));
  }

  /**
   * Resolved entries may go, except follow-up writes still to be made, actions whose follow-ups are not reserved
   * yet, and Teams records a re-run of their workflow run may still need. Teams records of any outcome go after
   * that window, so unknown deliveries cannot accumulate.
   */
  prunable(entry, now = Date.now()) {
    if (entry.kind === 'teams') {
      // An entry of unknown age is kept: it may still be inside the re-run window.
      const at = Date.parse(entry.settledAt ?? entry.at);
      return entry.status !== 'reserved' && Number.isFinite(at) && now - at > RETRY_WINDOW_MS;
    }
    if (!RESOLVED.has(entry.status) || retryPending(entry)) {
      return false;
    }
    return followUps(entry).every((item) => this.has(item.id));
  }

  /** Records intent before a remote write, so an interrupted write is reconciled instead of repeated. */
  async reserve(entry) {
    const existing = this.find(entry.id);
    if (existing) {
      return existing;
    }
    const record = { ...entry, status: 'reserved', at: new Date().toISOString() };
    this.journal.entries.push(record);
    await this.persistJournal();
    return record;
  }

  async settle(id, status, result = {}) {
    const record = this.find(id);
    Object.assign(record, { status, result, settledAt: new Date().toISOString() });
    await this.persistJournal();
    return record;
  }
}
