/**
 * Changes to documents: applying translation entries and pruning dead messages.
 *
 * Entries are plain objects; the tool layer validates them all before a single
 * atomic write, so a rejected entry never leaves a half-applied batch.
 */

import { checkText, severityLabel } from './checks.js';
import { State, SHORT_ID_LENGTH, hasText, isDead, sameMessage, stateOf } from './model.js';

/** Entry result kinds. */
export const Result = Object.freeze({
  UPDATED: 'updated',
  UNCHANGED: 'unchanged',
  REJECTED: 'rejected',
  NOT_FOUND: 'not_found',
});

export const ENTRY_FIELDS = Object.freeze(['id', 'context', 'source', 'comment', 'translation', 'state', 'note']);
export const ENTRY_STATES = Object.freeze(['finished', 'unfinished']);

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return value.replaceAll('\r\n', '\n');
}

/**
 * @param {string} message
 * @returns {object}
 */
function rejected(message) {
  return { kind: 'rejected', error: message };
}

/**
 * Validate one entry object.
 * @param {unknown} data
 * @returns {object} a parsed entry or `{kind: 'rejected', error}`
 */
export function parseEntry(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return rejected('entry must be a JSON object');
  const unknown = Object.keys(data).filter((key) => !ENTRY_FIELDS.includes(key));
  if (unknown.length > 0) {
    return rejected(`unknown field(s): ${unknown.sort().join(', ')}; allowed: ${ENTRY_FIELDS.join(', ')}`);
  }
  for (const name of ['id', 'context', 'source', 'comment', 'state', 'note']) {
    if (name in data && typeof data[name] !== 'string') return rejected(`${JSON.stringify(name)} must be a string`);
  }
  let translation;
  if ('translation' in data) {
    if (typeof data.translation === 'string') translation = normalizeText(data.translation);
    else if (Array.isArray(data.translation) && data.translation.every((form) => typeof form === 'string')) {
      translation = data.translation.map(normalizeText);
    } else {
      return rejected("'translation' must be a string, or a list of strings for plural forms");
    }
  }
  if (data.state !== undefined && data.state !== null && !ENTRY_STATES.includes(data.state)) {
    return rejected(`'state' must be one of: ${ENTRY_STATES.join(', ')}`);
  }
  const hasId = typeof data.id === 'string' && data.id.length > 0;
  const hasKey = 'context' in data && 'source' in data;
  if (hasId === hasKey) return rejected("identify the message either by 'id' or by 'context' + 'source' (+ 'comment')");
  if (!('translation' in data) && !('state' in data) && !('note' in data)) {
    return rejected("nothing to change: give 'translation', 'state' or 'note'");
  }
  return {
    kind: 'entry',
    shortId: hasId ? data.id.trim().toLowerCase() : undefined,
    context: data.context,
    source: 'source' in data ? normalizeText(data.source) : undefined,
    comment: data.comment ?? '',
    translation,
    state: data.state,
    note: 'note' in data ? normalizeText(data.note) : undefined,
  };
}

/**
 * Parse a JSON array or JSON Lines string into entries.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseEntryText(text) {
  const stripped = text.replace(/^\uFEFF/u, '').trim();
  if (stripped.startsWith('[')) {
    let items;
    try {
      items = JSON.parse(stripped);
    } catch (error) {
      return [{ line: 1, kind: 'rejected', error: `invalid JSON array: ${error.message}` }];
    }
    return items.map((item, index) => ({ line: index + 1, ...parseEntry(item) }));
  }
  const entries = [];
  const lines = stripped.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || line.trimStart().startsWith('//')) continue;
    try {
      entries.push({ line: index + 1, ...parseEntry(JSON.parse(line)) });
    } catch (error) {
      entries.push({ line: index + 1, kind: 'rejected', error: `invalid JSON: ${error.message}` });
    }
  }
  return entries;
}

/**
 * @param {import('./model.js').Message} message
 * @returns {object}
 */
function snapshot(message) {
  const record = {
    translation: message.numerus ? [...message.numerusForms] : message.translation,
    state: stateOf(message),
  };
  if (message.translatorComment) record.note = message.translatorComment;
  return record;
}

/**
 * @param {import('./model.js').Message} message
 * @param {object} entry
 * @returns {import('./model.js').Message|string}
 */
function updatedMessage(message, entry) {
  const changes = {};
  if (entry.translation !== undefined) {
    if (message.numerus && !Array.isArray(entry.translation)) {
      return "plural message: 'translation' must be a list of forms";
    }
    if (!message.numerus && Array.isArray(entry.translation)) {
      return "not a plural message: 'translation' must be a string";
    }
    if (message.numerus) changes.numerusForms = entry.translation;
    else changes.translation = entry.translation;
  }
  if (entry.state !== undefined) {
    changes.translationType = entry.state === 'finished' ? null : 'unfinished';
  } else if (entry.translation !== undefined) {
    const texts = Array.isArray(entry.translation) ? entry.translation : [entry.translation];
    changes.translationType = texts.some((text) => text.length > 0) ? null : 'unfinished';
  }
  if (entry.note !== undefined) changes.translatorComment = entry.note;
  return { ...message, ...changes };
}

/**
 * @param {import('./checks.js').Finding} finding
 * @returns {object}
 */
function issueOf(finding) {
  return { rule: finding.rule, severity: severityLabel(finding.severity), detail: finding.detail };
}

/**
 * Apply parsed entries in place.
 * @param {import('./context.js').LoadedLanguage} language
 * @param {Array<object>} entries
 * @param {{force?: boolean, glossary?: import('./glossary.js').Glossary|null}} [options]
 * @returns {Array<object>}
 */
export function applyEntries(language, entries, options = {}) {
  const force = options.force ?? false;
  const glossary = options.glossary ?? null;
  const results = [];
  const seenKeys = new Map();

  for (const entry of entries) {
    if (entry.kind === 'rejected') {
      results.push({ line: entry.line, result: Result.REJECTED, error: entry.error });
      continue;
    }
    const targets = findTargets(language, entry);
    if (typeof targets === 'string') {
      results.push({ line: entry.line, result: Result.REJECTED, entry, error: targets });
      continue;
    }
    if (targets.length === 0) {
      let error = `no such message in ${language.file.language}`;
      if (entry.shortId !== undefined && entry.shortId.length !== SHORT_ID_LENGTH) {
        error += ` (apply needs full ${SHORT_ID_LENGTH}-character ids)`;
      }
      results.push({ line: entry.line, result: Result.NOT_FOUND, entry, error });
      continue;
    }
    const message = targets[0];
    const result = {
      line: entry.line,
      result: Result.UPDATED,
      entry,
      message,
      issues: [],
    };
    results.push(result);

    const key = `${message.context}\0${message.source}\0${message.comment}`;
    if (seenKeys.has(key)) {
      result.result = Result.REJECTED;
      result.error = `the same message was already changed on line ${seenKeys.get(key)}`;
      continue;
    }
    seenKeys.set(key, entry.line);
    if (isDead(message)) {
      result.result = Result.REJECTED;
      result.error = 'message is vanished; it is no longer in the sources';
      continue;
    }

    const updated = updatedMessage(message, entry);
    if (typeof updated === 'string') {
      result.result = Result.REJECTED;
      result.error = updated;
      continue;
    }
    result.issues = checkText(updated, language, glossary).map(issueOf);
    if ((entry.translation !== undefined || entry.state !== undefined) && stateOf(updated) === State.BLANK) {
      result.issues.push({
        rule: 'blank',
        severity: 'error',
        detail:
          "finished without text shows an empty string; omit 'state' to keep it unfinished, or copy the source text to keep it untranslated",
      });
    }
    if (
      updated.translationType === 'unfinished' &&
      hasText(updated) &&
      !updated.translatorComment &&
      !language.isSourceLanguage
    ) {
      result.issues.push({
        rule: 'draft-without-note',
        severity: 'warning',
        detail: 'unfinished translation without a note listing the variants to choose from',
      });
    }
    const blocking = result.issues.filter((issue) => issue.severity === 'error');
    if (blocking.length > 0 && !force) {
      result.result = Result.REJECTED;
      result.error = 'error-level issues; fix the translation or set force=true';
      continue;
    }

    result.before = snapshot(message);
    if (sameMessage(updated, message)) {
      result.result = Result.UNCHANGED;
      delete result.before;
      continue;
    }
    for (const target of targets) {
      target.translation = updated.translation;
      target.numerusForms = [...updated.numerusForms];
      target.translationType = updated.translationType;
      target.translatorComment = updated.translatorComment;
    }
    result.after = snapshot(message);
  }
  return results;
}

/**
 * @param {import('./context.js').LoadedLanguage} language
 * @param {object} entry
 * @returns {import('./model.js').Message[]|string}
 */
function findTargets(language, entry) {
  if (entry.shortId !== undefined) {
    const candidates = language.byId.get(entry.shortId) ?? [];
    const keys = new Set(candidates.map((message) => `${message.context}\0${message.source}\0${message.comment}`));
    if (keys.size > 1) return "id collision: identify this message by 'context' + 'source'";
    return candidates;
  }
  const key = `${entry.context}\0${entry.source}\0${entry.comment}`;
  const message = language.byKey.get(key);
  return message === undefined ? [] : [message];
}

/**
 * Remove vanished/obsolete messages and contexts left without messages.
 * @param {import('./model.js').TsDocument} document
 * @returns {{messages: import('./model.js').Message[], contexts: Array<{name: string}>}}
 */
export function pruneDocument(document) {
  const removedMessages = [];
  const removedContexts = [];
  const keptContexts = [];
  for (const context of document.contexts) {
    for (const message of context.messages) {
      if (isDead(message)) removedMessages.push(message);
    }
    context.messages = context.messages.filter((message) => !isDead(message));
    if (context.messages.length > 0) keptContexts.push(context);
    else removedContexts.push(context);
  }
  document.contexts = keptContexts;
  return { messages: removedMessages, contexts: removedContexts };
}

/**
 * Count results by kind.
 * @param {Array<object>} results
 * @returns {Record<string, number>}
 */
export function countResults(results) {
  const counts = { updated: 0, unchanged: 0, rejected: 0, not_found: 0 };
  for (const result of results) counts[result.result] += 1;
  return counts;
}

/**
 * Serialize one apply result for the tool response.
 * @param {object} result
 * @returns {object}
 */
export function resultRecord(result) {
  const record = { line: result.line };
  if (result.message !== undefined) {
    record.id = result.message.shortId;
    record.context = result.message.context;
    record.source = result.message.source;
  } else if (result.entry?.shortId) {
    record.id = result.entry.shortId;
  }
  record.result = result.result;
  if (result.error) record.error = result.error;
  if (result.before !== undefined) record.before = result.before;
  if (result.after !== undefined) record.after = result.after;
  if (result.issues !== undefined && result.issues.length > 0) record.issues = result.issues;
  return record;
}
