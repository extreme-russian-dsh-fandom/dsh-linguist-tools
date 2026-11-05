/**
 * Terminology glossary (`glossary.json` next to the `.ts` files).
 *
 * Full parity with the original tstools glossary: approved/proposed statuses,
 * context-scoped entries, per-message exceptions, `variants`, `avoid`, custom
 * `match` patterns, and longest-match-first term detection. The file is
 * optional; a missing glossary is an empty glossary.
 */

/** Path of the default glossary inside a translations directory. */
export const GLOSSARY_VERSION = 1;

/** Term statuses. */
export const Status = Object.freeze({ APPROVED: 'approved', PROPOSED: 'proposed' });

const TERM_FIELDS = new Set(['term', 'match', 'case_sensitive', 'contexts', 'status', 'note', 'exceptions']);
const RENDERING_FIELDS = new Set(['translation', 'match', 'variants', 'avoid', 'note', 'status']);
const LANGUAGE_KEY = /^[a-z]{2,3}$/u;
const WORD_SEPARATOR = /[\s\-_]+/u;
const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

/** A malformed or unreadable glossary. */
export class GlossaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GlossaryError';
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Whole words, any of space/hyphen/underscore between them, optional plural.
 * @param {string} term
 * @returns {string}
 */
export function defaultSourcePattern(term) {
  const words = term
    .trim()
    .split(WORD_SEPARATOR)
    .filter(Boolean)
    .map(escapeRegExp);
  return `${WORD_BOUNDARY_BEFORE}${words.join('[\\s\\-_]+')}(?:s|es)?${WORD_BOUNDARY_AFTER}`;
}

/**
 * @param {string} pattern
 * @param {boolean} caseSensitive
 * @param {string} where
 * @returns {RegExp}
 */
function compile(pattern, caseSensitive, where) {
  try {
    return new RegExp(pattern, caseSensitive ? 'gu' : 'giu');
  } catch (error) {
    throw new GlossaryError(`${where}: bad regular expression ${JSON.stringify(pattern)}: ${error.message}`);
  }
}

/**
 * Iterate the matches of a global regex without leaking `lastIndex`.
 * @param {RegExp} pattern
 * @param {string} text
 * @returns {IterableIterator<RegExpExecArray>}
 */
export function* matchesOf(pattern, text) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) yield match;
  pattern.lastIndex = 0;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string[]}
 */
function stringList(value, where) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new GlossaryError(`${where}: expected a list of strings`);
  }
  return [...value];
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function parseStatus(value, where) {
  if (value !== Status.APPROVED && value !== Status.PROPOSED) {
    throw new GlossaryError(`${where}: 'status' must be one of ${Status.APPROVED}, ${Status.PROPOSED}`);
  }
  return value;
}

/**
 * One required rendering of a term.
 */
export class Rendering {
  constructor({ language, translation, pattern, status, variants, avoid, note }) {
    this.language = language;
    this.translation = translation;
    this.pattern = pattern;
    this.status = status;
    this.variants = variants;
    this.avoid = avoid;
    this.note = note;
  }

  /** @returns {object} */
  toRecord() {
    const record = { translation: this.translation, status: this.status };
    if (this.variants.length > 0) record.variants = [...this.variants];
    if (this.avoid.length > 0) record.avoid = [...this.avoid];
    if (this.note) record.note = this.note;
    return record;
  }
}

/**
 * One glossary term with per-language renderings.
 */
export class Term {
  constructor({ term, pattern, status, renderings, contexts, note, exceptions }) {
    this.term = term;
    this.pattern = pattern;
    this.status = status;
    this.renderings = renderings;
    this.contexts = contexts;
    this.note = note;
    this.exceptions = exceptions;
  }

  get scoped() {
    return this.contexts !== null;
  }

  /**
   * @param {string} context
   * @returns {boolean}
   */
  appliesTo(context) {
    if (this.contexts === null) return true;
    this.contexts.lastIndex = 0;
    const matches = this.contexts.test(context);
    this.contexts.lastIndex = 0;
    return matches;
  }

  /** @returns {object} */
  toRecord() {
    const record = { term: this.term, status: this.status };
    if (this.contexts !== null) record.contexts = this.contexts.source;
    if (this.note) record.note = this.note;
    for (const [language, rendering] of Object.entries(this.renderings)) record[language] = rendering.toRecord();
    if (this.exceptions.size > 0) record.exceptions = [...this.exceptions].sort();
    return record;
  }

  /** @returns {object} */
  brief() {
    const record = { term: this.term };
    for (const [language, rendering] of Object.entries(this.renderings)) record[language] = rendering.translation;
    const proposed = Object.entries(this.renderings)
      .filter(([, rendering]) => rendering.status === Status.PROPOSED)
      .map(([language]) => language);
    if (proposed.length > 0) record.proposed = proposed;
    return record;
  }
}

/**
 * One term found in a source text.
 */
export class TermMatch {
  constructor(term) {
    this.term = term;
    this.texts = [];
  }
}

/**
 * A parsed glossary.
 */
export class Glossary {
  /**
   * @param {Term[]} terms
   * @param {string|null} [filePath]
   */
  constructor(terms = [], filePath = null) {
    this.terms = terms;
    this.path = filePath;
  }

  /**
   * @param {string} source
   * @param {string} context
   * @returns {Term[]}
   */
  find(source, context) {
    return this.findMatches(source, context).map((match) => match.term);
  }

  /**
   * Terms used in a source, longest match first, so "probe head" hides "probe".
   * @param {string} source
   * @param {string} context
   * @returns {TermMatch[]}
   */
  findMatches(source, context) {
    let applicable = this.terms.filter((term) => term.appliesTo(context));
    const scoped = new Set(applicable.filter((term) => term.scoped).map((term) => term.term.toLowerCase()));
    applicable = applicable.filter((term) => term.scoped || !scoped.has(term.term.toLowerCase()));

    const candidates = [];
    for (let order = 0; order < applicable.length; order += 1) {
      const term = applicable[order];
      for (const match of matchesOf(term.pattern, source)) {
        const start = match.index;
        const end = start + match[0].length;
        if (end <= start) continue;
        candidates.push({ start, end, order, term });
      }
    }
    candidates.sort((left, right) => left.start - left.end - (right.start - right.end) || left.start - right.start || left.order - right.order);

    const taken = [];
    const accepted = [];
    for (const candidate of candidates) {
      const overlaps = taken.some(([start, end]) => candidate.start < end && start < candidate.end);
      if (overlaps) continue;
      taken.push([candidate.start, candidate.end]);
      accepted.push(candidate);
    }
    accepted.sort((left, right) => left.start - right.start);

    const found = [];
    for (const candidate of accepted) {
      let match = found.find((entry) => entry.term === candidate.term);
      if (match === undefined) {
        match = new TermMatch(candidate.term);
        found.push(match);
      }
      match.texts.push(source.slice(candidate.start, candidate.end));
    }
    return found;
  }
}

/**
 * @param {string} language
 * @param {unknown} data
 * @param {boolean} caseSensitive
 * @param {string} defaultStatus
 * @param {string} where
 * @returns {Rendering}
 */
function parseRendering(language, data, caseSensitive, defaultStatus, where) {
  const source = typeof data === 'string' ? { translation: data } : data;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new GlossaryError(`${where}: expected a string or an object`);
  }
  const unknown = Object.keys(source).filter((key) => !RENDERING_FIELDS.has(key));
  if (unknown.length > 0) throw new GlossaryError(`${where}: unknown field(s) ${unknown.sort().join(', ')}`);
  const translation = source.translation;
  if (typeof translation !== 'string' || translation.length === 0) {
    throw new GlossaryError(`${where}: 'translation' must be a non-empty string`);
  }
  const pattern = source.match ?? escapeRegExp(translation);
  if (typeof pattern !== 'string') throw new GlossaryError(`${where}: 'match' must be a string`);
  const note = source.note ?? '';
  if (typeof note !== 'string') throw new GlossaryError(`${where}: 'note' must be a string`);
  return new Rendering({
    language,
    translation,
    pattern: compile(pattern, caseSensitive, where),
    status: parseStatus(source.status ?? defaultStatus, where),
    variants: stringList(source.variants ?? [], `${where}.variants`),
    avoid: stringList(source.avoid ?? [], `${where}.avoid`),
    note,
  });
}

/**
 * @param {number} index
 * @param {unknown} data
 * @returns {Term}
 */
function parseTerm(index, data) {
  let where = `terms[${index}]`;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new GlossaryError(`${where}: expected an object`);
  }
  const term = data.term;
  if (typeof term !== 'string' || term.trim().length === 0) {
    throw new GlossaryError(`${where}: 'term' must be a non-empty string`);
  }
  where = `${where} (${JSON.stringify(term)})`;
  const languages = Object.keys(data).filter((key) => LANGUAGE_KEY.test(key));
  const unknown = Object.keys(data).filter((key) => !TERM_FIELDS.has(key) && !LANGUAGE_KEY.test(key));
  if (unknown.length > 0) throw new GlossaryError(`${where}: unknown field(s) ${unknown.sort().join(', ')}`);
  const caseSensitive = data.case_sensitive ?? false;
  if (typeof caseSensitive !== 'boolean') throw new GlossaryError(`${where}: 'case_sensitive' must be true or false`);
  const status = parseStatus(data.status ?? Status.APPROVED, where);
  for (const name of ['match', 'contexts', 'note']) {
    if (name in data && typeof data[name] !== 'string') throw new GlossaryError(`${where}: '${name}' must be a string`);
  }
  if (languages.length === 0) {
    throw new GlossaryError(`${where}: no translations (language keys such as "ru", "zh")`);
  }
  const contexts = data.contexts;
  const renderings = {};
  for (const language of languages.sort()) {
    renderings[language] = parseRendering(language, data[language], caseSensitive, status, `${where}.${language}`);
  }
  return new Term({
    term,
    pattern: compile(data.match ?? defaultSourcePattern(term), caseSensitive, `${where}.match`),
    status,
    renderings,
    contexts: contexts === undefined ? null : compile(contexts, true, `${where}.contexts`),
    note: data.note ?? '',
    exceptions: new Set(stringList(data.exceptions ?? [], `${where}.exceptions`).map((item) => item.toLowerCase())),
  });
}

/**
 * Parse a glossary document.
 * @param {string} text
 * @param {string|null} [filePath]
 * @returns {Glossary}
 */
export function parseGlossary(text, filePath = null) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const position = /at position (\d+)/u.exec(error.message);
    let where = '';
    if (position !== null) {
      const offset = Number.parseInt(position[1], 10);
      const before = text.slice(0, offset);
      const line = before.split('\n').length;
      const column = offset - before.lastIndexOf('\n');
      where = ` at line ${line}, column ${column}`;
    }
    throw new GlossaryError(`invalid JSON${where}: ${error.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.terms)) {
    throw new GlossaryError('expected an object with a "terms" list');
  }
  if ((data.version ?? GLOSSARY_VERSION) !== GLOSSARY_VERSION) {
    throw new GlossaryError(`unsupported glossary version ${JSON.stringify(data.version)}`);
  }
  return new Glossary(
    data.terms.map((term, index) => parseTerm(index, term)),
    filePath,
  );
}

/**
 * Filter a term record to selected language keys.
 * @param {Term} term
 * @param {Set<string>|null} languages
 * @returns {object}
 */
export function termRecord(term, languages = null) {
  const record = term.toRecord();
  if (languages !== null) {
    for (const key of Object.keys(term.renderings)) {
      if (!languages.has(key)) delete record[key];
    }
  }
  return record;
}
