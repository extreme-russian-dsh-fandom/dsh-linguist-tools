/**
 * Read-only queries over loaded translation files.
 */

import { ACTIVE_STATES, ALL_STATES, State, messageTexts, stateOf } from './model.js';
import { displayPath, isBuildLocation, resolveLocation } from './project.js';

/** Minimum accepted id prefix. */
export const MINIMUM_ID_PREFIX_LENGTH = 4;

/** A query-argument error. */
export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryError';
  }
}

/**
 * @param {string|undefined} spec
 * @returns {Set<string>}
 */
export function parseStates(spec) {
  if (!spec) return new Set(ACTIVE_STATES);
  const states = new Set();
  for (const raw of spec.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    if (raw === 'active') {
      for (const state of ACTIVE_STATES) states.add(state);
    } else if (raw === 'all') {
      for (const state of ALL_STATES) states.add(state);
    } else if (ALL_STATES.includes(raw)) {
      states.add(raw);
    } else {
      throw new QueryError(`unknown state ${JSON.stringify(raw)}; known: ${[...ALL_STATES, 'active', 'all'].join(', ')}`);
    }
  }
  return states;
}

/**
 * @param {string|undefined} pattern
 * @param {boolean} literal
 * @param {boolean} caseSensitive
 * @returns {RegExp|null}
 */
export function compileFilter(pattern, literal, caseSensitive) {
  if (pattern === undefined || pattern === null) return null;
  try {
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : pattern;
    return new RegExp(source, caseSensitive ? 'u' : 'iu');
  } catch (error) {
    throw new QueryError(`bad regular expression ${JSON.stringify(pattern)}: ${error.message}`);
  }
}

/**
 * Filters applied to messages of one language.
 */
export class MessageFilter {
  /**
   * @param {object} options
   * @param {Set<string>} options.states
   * @param {RegExp|null} [options.context]
   * @param {RegExp|null} [options.source]
   * @param {RegExp|null} [options.translation]
   * @param {RegExp|null} [options.location]
   * @param {string[]} [options.ids]
   */
  constructor({ states, context = null, source = null, translation = null, location = null, ids = [] }) {
    this.states = states;
    this.context = context;
    this.source = source;
    this.translation = translation;
    this.location = location;
    this.ids = ids;
  }

  /**
   * @param {import('./model.js').Message} message
   * @returns {boolean}
   */
  matches(message) {
    if (!this.states.has(stateOf(message))) return false;
    if (this.ids.length > 0 && !this.ids.some((prefix) => message.shortId.startsWith(prefix))) return false;
    if (this.context !== null) {
      this.context.lastIndex = 0;
      if (!this.context.test(message.context)) return false;
    }
    if (this.source !== null) {
      this.source.lastIndex = 0;
      if (!this.source.test(message.source)) return false;
    }
    if (this.translation !== null && !messageTexts(message).some((text) => {
      this.translation.lastIndex = 0;
      return this.translation.test(text);
    })) {
      return false;
    }
    if (this.location !== null) {
      this.location.lastIndex = 0;
      const matched = message.locations.some((location) => {
        this.location.lastIndex = 0;
        return this.location.test(location.filename ?? '');
      });
      if (!matched) return false;
    }
    return true;
  }
}

/**
 * @param {import('./model.js').Message} message
 * @returns {string|string[]}
 */
export function translationValue(message) {
  return message.numerus ? [...message.numerusForms] : message.translation;
}

/**
 * @param {string} translationPath
 * @param {{filename: string|null, line: string|null}} location
 * @param {string} root
 * @returns {string}
 */
export function formatLocation(translationPath, location, root) {
  const resolved = location.filename ? displayPath(resolveLocation(translationPath, location.filename), root) : '?';
  return location.line ? `${resolved}:${location.line}` : resolved;
}

/**
 * Source locations without build-tree duplicates.
 * @param {string} translationPath
 * @param {import('./model.js').Message[]} messages
 * @param {{root: string, buildDirectories: readonly string[]}} layout
 * @returns {{locations: string[], buildCount: number}}
 */
export function splitLocations(translationPath, messages, layout) {
  const shown = [];
  let buildCount = 0;
  for (const message of messages) {
    for (const location of message.locations) {
      if (location.filename && isBuildLocation(resolveLocation(translationPath, location.filename), layout.root, layout.buildDirectories)) {
        buildCount += 1;
        continue;
      }
      const formatted = formatLocation(translationPath, location, layout.root);
      if (!shown.includes(formatted)) shown.push(formatted);
    }
  }
  return { locations: shown, buildCount };
}

/**
 * @param {import('./model.js').Message} message
 * @returns {object}
 */
export function describeMessage(message) {
  const record = { id: message.shortId, context: message.context, source: message.source };
  if (message.comment) record.comment = message.comment;
  if (message.extraComment) record.extra = message.extraComment;
  if (message.numerus) record.numerus = true;
  return record;
}

/**
 * @param {import('./model.js').Message|null|undefined} message
 * @returns {object|null}
 */
export function translationEntry(message) {
  if (message === undefined || message === null) return null;
  const entry = { translation: translationValue(message), state: stateOf(message) };
  if (message.translatorComment) entry.note = message.translatorComment;
  return entry;
}

/**
 * @param {import('./model.js').Message} message
 * @param {import('./context.js').LoadedLanguage} primary
 * @param {Array<import('./context.js').LoadedLanguage>} others
 * @param {boolean} withLocations
 * @param {{root: string, buildDirectories: readonly string[]}} layout
 * @returns {object}
 */
export function listRecord(message, primary, others, withLocations, layout) {
  const record = describeMessage(message);
  record.translation = translationValue(message);
  record.state = stateOf(message);
  if (message.translatorComment) record.note = message.translatorComment;
  if (others.length > 0) {
    record.others = {};
    for (const other of others) {
      const key = `${message.context}\0${message.source}\0${message.comment}`;
      record.others[other.file.language] = translationEntry(other.byKey.get(key));
    }
  }
  if (withLocations) {
    const { locations, buildCount } = splitLocations(primary.file.path, [message], layout);
    record.locations = locations;
    if (buildCount > 0) record.build_locations = buildCount;
  }
  return record;
}

/**
 * Expand requested ids and unique prefixes against known ids.
 * @param {string[]} specs
 * @param {Array<import('./context.js').LoadedLanguage>} languages
 * @returns {Map<string, string[]>}
 */
export function resolveIds(specs, languages) {
  const known = [...new Set(languages.flatMap((language) => [...language.byId.keys()]))].sort();
  const resolved = new Map();
  for (const raw of specs) {
    const spec = raw.trim().toLowerCase();
    if (known.includes(spec)) resolved.set(spec, [spec]);
    else if (spec.length >= MINIMUM_ID_PREFIX_LENGTH) resolved.set(spec, known.filter((id) => id.startsWith(spec)));
    else resolved.set(spec, []);
  }
  return resolved;
}

/**
 * @param {string} shortId
 * @param {Array<import('./context.js').LoadedLanguage>} languages
 * @param {number} codeRadius
 * @param {{root: string, buildDirectories: readonly string[]}} layout
 * @returns {object}
 */
export function showRecord(shortId, languages, codeRadius, layout) {
  const present = languages.map((language) => [language, language.byId.get(shortId) ?? []]);
  const first = present.find(([, messages]) => messages.length > 0);
  if (first === undefined) throw new QueryError(`message ${shortId} not found`);
  const record = describeMessage(first[1][0]);
  record.translations = {};
  for (const [language, messages] of present) {
    record.translations[language.file.language] = translationEntry(messages[0]);
  }
  const collisions = new Set();
  for (const [, messages] of present) {
    for (const message of messages) collisions.add(`${message.context}\0${message.source}\0${message.comment}`);
  }
  if (collisions.size > 1) {
    record.id_collision = [...collisions].sort().map((key) => key.split('\0'));
  }

  let best = present.find(([, messages]) => messages.length > 0);
  for (const candidate of present) {
    if (candidate[1].length === 0) continue;
    if (best === undefined || candidate[1][0].locations.length > best[1][0].locations.length) best = candidate;
  }
  const [language, messages] = best;
  const { locations, buildCount } = splitLocations(language.file.path, messages, layout);
  record.locations = locations;
  if (buildCount > 0) record.build_locations = buildCount;
  if (codeRadius > 0) record.code = [];
  return record;
}

/**
 * Build the code excerpts for a shown message.
 * @param {import('./context.js').Runtime} runtime
 * @param {string} translationPath
 * @param {import('./model.js').Message[]} messages
 * @param {number} radius
 * @param {{root: string, buildDirectories: readonly string[]}} layout
 * @returns {Promise<Array<object>>}
 */
export async function codeExcerpts(runtime, translationPath, messages, radius, layout) {
  const excerpts = [];
  const seen = new Set();
  for (const message of messages) {
    for (const location of message.locations) {
      if (!location.filename || !location.line || !/^\d+$/u.test(location.line)) continue;
      const absolute = resolveLocation(translationPath, location.filename);
      if (isBuildLocation(absolute, layout.root, layout.buildDirectories)) continue;
      const key = `${absolute}:${location.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const excerpt = { location: `${displayPath(absolute, layout.root)}:${location.line}` };
      try {
        const window = await runtime.readCodeWindow(absolute, Number.parseInt(location.line, 10), radius);
        excerpt.lines = window.lines;
      } catch (error) {
        excerpt.error = error instanceof Error ? error.message : 'file not found';
      }
      excerpts.push(excerpt);
    }
  }
  return excerpts;
}

/**
 * @param {import('./context.js').LoadedLanguage} language
 * @param {number|null} missingActive
 * @returns {object}
 */
export function statsRecord(language, missingActive) {
  const counts = new Map();
  let messages = 0;
  for (const context of language.document.contexts) {
    for (const message of context.messages) {
      messages += 1;
      const state = stateOf(message);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
  }
  const record = {
    lang: language.file.language,
    file: language.file.displayPath,
    contexts: language.document.contexts.length,
    messages,
  };
  for (const state of ALL_STATES) record[state] = counts.get(state) ?? 0;
  if (missingActive !== null) record.missing_active = missingActive;
  record.format_drift = language.document.formatDrift
    ? `line ${language.document.formatDrift.line}: file has ${JSON.stringify(language.document.formatDrift.expected)}, lupdate format is ${JSON.stringify(language.document.formatDrift.actual)}`
    : null;
  record.write_blockers = [...language.document.writeBlockers];
  return record;
}

/**
 * Per-language count of messages active in another loaded file but missing or
 * dead in this one.
 * @param {Array<import('./context.js').LoadedLanguage>} languages
 * @returns {Map<string, number>}
 */
export function missingActiveCounts(languages) {
  const active = new Map();
  const union = new Set();
  for (const language of languages) {
    const keys = new Set();
    for (const context of language.document.contexts) {
      for (const message of context.messages) {
        if (stateOf(message) === State.VANISHED) continue;
        const key = `${message.context}\0${message.source}\0${message.comment}`;
        keys.add(key);
        union.add(key);
      }
    }
    active.set(language.file.language, keys);
  }
  const counts = new Map();
  for (const [language, keys] of active) {
    let missing = 0;
    for (const key of union) if (!keys.has(key)) missing += 1;
    counts.set(language, missing);
  }
  return counts;
}

/**
 * @param {import('./context.js').LoadedLanguage} language
 * @returns {object[]}
 */
export function contextStatsRecords(language) {
  const records = [];
  for (const context of language.document.contexts) {
    const counts = new Map();
    for (const message of context.messages) {
      const state = stateOf(message);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    const record = { lang: language.file.language, context: context.name, messages: context.messages.length };
    for (const state of ALL_STATES) record[state] = counts.get(state) ?? 0;
    records.push(record);
  }
  return records;
}
