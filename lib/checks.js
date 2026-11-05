/**
 * Lint rules for Qt Linguist translation files.
 *
 * `checkText()` is also used by `apply` to validate a translation before it is
 * written. The rule set matches the original tstools implementation, including
 * the optional glossary rules.
 */

import { baseLanguage } from './project.js';
import { resolveLocation, isBuildLocation } from './project.js';
import { Status } from './glossary.js';
import { messageTexts, isDead, hasText, stateOf, State, ACTIVE_STATES } from './model.js';

/** Rule severities, ordered. */
export const Severity = Object.freeze({ INFO: 1, WARNING: 2, ERROR: 3 });

/** Every rule, its severity, and its one-line description. */
export const RULES = Object.freeze({
  unreadable: [Severity.ERROR, 'file cannot be read or parsed (I/O, encoding, malformed XML, structure)'],
  'merge-conflict': [Severity.ERROR, 'git merge conflict markers in the file'],
  'write-blocked': [Severity.ERROR, 'file cannot be written back without losing data'],
  'glossary-invalid': [Severity.ERROR, 'glossary.json cannot be read or is malformed'],
  placeholders: [Severity.ERROR, '%1..%99 / %n placeholders differ between source and translation'],
  'numerus-forms': [Severity.ERROR, 'number of plural forms does not match the language'],
  'duplicate-key': [Severity.ERROR, 'the same (context, source, comment) appears twice in a file'],
  'id-collision': [Severity.ERROR, 'two different messages share a short id'],
  'format-drift': [Severity.WARNING, 'formatting differs from lupdate output; normalized on the next write'],
  untranslated: [Severity.WARNING, 'no translation (unfinished and empty)'],
  mnemonic: [Severity.WARNING, '&-mnemonic present in only one of source and translation'],
  'edge-whitespace': [Severity.WARNING, 'leading/trailing whitespace differs from the source'],
  markup: [Severity.WARNING, 'HTML tags differ between source and translation'],
  'wrong-script': [Severity.WARNING, "translation contains characters of another language's script"],
  'source-not-english': [Severity.WARNING, 'source text is not English'],
  desync: [Severity.WARNING, 'message is active in another language file but missing or dead here'],
  'build-only-location': [Severity.WARNING, 'message only exists in generated build-tree files'],
  vanished: [Severity.WARNING, 'vanished/obsolete messages left in the file; run prune'],
  blank: [Severity.ERROR, 'finished without text: Qt shows an empty string instead of the source'],
  'en-identical': [Severity.WARNING, 'source-language override equal to the source; clear it (unfinished, empty)'],
  'glossary-avoid': [Severity.WARNING, 'a glossary term is translated with a rendering the glossary marks as wrong'],
  identical: [Severity.INFO, 'translation equals the source text'],
  newlines: [Severity.INFO, 'number of line breaks differs from the source'],
  'no-native-script': [Severity.INFO, 'translation differs from the source but has no characters of its script'],
  draft: [Severity.INFO, 'unfinished translation waiting for review'],
  glossary: [Severity.INFO, 'an approved glossary term is not translated as the glossary says'],
  'glossary-proposed': [Severity.INFO, 'a proposed (not yet approved) glossary term is translated differently'],
  'legacy-obsolete': [Severity.INFO, 'Qt 4 style type="obsolete"'],
});

const PLACEHOLDER = /%L?(\d{1,2}|n)/gu;
const ENTITY = /&(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);/gu;
const MNEMONIC = /&(?=\S)/u;
const TAG = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)\b[^<>]*>/gu;
const HTML_TAGS = new Set(
  'a b big blockquote body br center code div em font h1 h2 h3 h4 h5 h6 head hr html i img li nobr ol p pre qt s small span strong style sub sup table td th tr tt u ul'.split(
    ' ',
  ),
);
const IDENTICAL_MINIMUM_LENGTH = 3;

/** Scripts the checks know. */
export const Script = Object.freeze({ LATIN: 'Latin', CYRILLIC: 'Cyrillic', CJK: 'CJK' });

const SCRIPT_PATTERNS = {
  [Script.LATIN]: /\p{Script=Latin}/u,
  [Script.CYRILLIC]: /\p{Script=Cyrillic}/u,
  [Script.CJK]: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
};

const NUMERUS_FORM_COUNTS = Object.freeze({
  en: 2,
  de: 2,
  fr: 2,
  es: 2,
  it: 2,
  ru: 3,
  uk: 3,
  be: 3,
  pl: 3,
  cs: 3,
  zh: 1,
  ja: 1,
  ko: 1,
});

const EXPECTED_SCRIPTS = Object.freeze({
  en: Script.LATIN,
  de: Script.LATIN,
  fr: Script.LATIN,
  es: Script.LATIN,
  it: Script.LATIN,
  pl: Script.LATIN,
  cs: Script.LATIN,
  ru: Script.CYRILLIC,
  uk: Script.CYRILLIC,
  be: Script.CYRILLIC,
  zh: Script.CJK,
  ja: Script.CJK,
});

const FOREIGN_SCRIPTS = {
  [Script.LATIN]: [Script.CYRILLIC, Script.CJK],
  [Script.CYRILLIC]: [Script.CJK],
  [Script.CJK]: [Script.CYRILLIC],
};

/**
 * @param {number} severity
 * @returns {string}
 */
export function severityLabel(severity) {
  if (severity === Severity.ERROR) return 'error';
  if (severity === Severity.WARNING) return 'warning';
  return 'info';
}

/**
 * @param {string} text
 * @returns {number}
 */
export function parseSeverity(text) {
  if (text === 'error') return Severity.ERROR;
  if (text === 'warning') return Severity.WARNING;
  if (text === 'info') return Severity.INFO;
  throw new Error(`unknown severity ${JSON.stringify(text)}; use error, warning, or info`);
}

/**
 * @param {string} language
 * @returns {number|undefined}
 */
export function numerusFormCount(language) {
  return NUMERUS_FORM_COUNTS[baseLanguage(language)];
}

/**
 * @param {string} language
 * @returns {string|undefined}
 */
export function expectedScript(language) {
  return EXPECTED_SCRIPTS[baseLanguage(language)];
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function scriptsIn(text) {
  const found = new Set();
  for (const [script, pattern] of Object.entries(SCRIPT_PATTERNS)) {
    if (pattern.test(text)) found.add(script);
  }
  return found;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function hasLetters(text) {
  return /\p{L}/u.test(text);
}

/**
 * A lint finding.
 */
export class Finding {
  /**
   * @param {string} rule
   * @param {string} detail
   * @param {string|null} language
   * @param {any|null} message
   * @param {{line?: number|null, count?: number|null}} [extra]
   */
  constructor(rule, detail, language = null, message = null, extra = {}) {
    this.rule = rule;
    this.detail = detail;
    this.language = language;
    this.message = message;
    this.line = extra.line ?? null;
    this.count = extra.count ?? null;
  }

  get severity() {
    return RULES[this.rule]?.[0] ?? Severity.WARNING;
  }

  /** @returns {object} */
  toRecord() {
    const record = { rule: this.rule, severity: severityLabel(this.severity), lang: this.language };
    if (this.message !== null) {
      record.id = this.message.shortId;
      record.context = this.message.context;
      record.source = this.message.source;
      if (this.language !== null && hasText(this.message)) record.translation = translationValue(this.message);
    }
    record.detail = this.detail;
    if (this.line !== null) record.line = this.line;
    if (this.count !== null) record.count = this.count;
    return record;
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
 * @param {string} text
 * @returns {Set<string>}
 */
function placeholders(text) {
  const found = new Set();
  for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1]);
  return found;
}

/**
 * @param {Set<string>} values
 * @returns {string}
 */
function formatPlaceholders(values) {
  const ordered = [...values].sort((left, right) => {
    const leftN = left === 'n' ? 1 : 0;
    const rightN = right === 'n' ? 1 : 0;
    if (leftN !== rightN) return leftN - rightN;
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  });
  return ordered.length === 0 ? 'none' : ordered.map((item) => `%${item}`).join(' ');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasMnemonic(text) {
  const cleaned = text.replaceAll('&&', '').replace(ENTITY, '');
  return MNEMONIC.test(cleaned);
}

/**
 * @param {string} text
 * @returns {Map<string, number>}
 */
function tags(text) {
  const counts = new Map();
  for (const match of text.matchAll(TAG)) {
    const name = match[2].toLowerCase();
    if (!HTML_TAGS.has(name)) continue;
    const key = `${match[1]}${name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * @param {string} text
 * @returns {[boolean, boolean]}
 */
function edges(text) {
  return [/\s/u.test(text.slice(0, 1)), /\s/u.test(text.slice(-1))];
}

/**
 * @param {Map<string, number>} left
 * @param {Map<string, number>} right
 * @returns {boolean}
 */
function sameCounts(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/**
 * @param {import('./model.js').Message} message
 * @returns {Array<[string, string]>}
 */
function textPairs(message) {
  return messageTexts(message).filter((text) => text.length > 0).map((text) => [message.source, text]);
}

/**
 * Rules about the translation text itself.
 * @param {import('./model.js').Message} message
 * @param {import('./context.js').LoadedLanguage} language
 * @param {import('./glossary.js').Glossary|null} glossary
 * @returns {Finding[]}
 */
export function checkText(message, language, glossary = null) {
  if (isDead(message) || !hasText(message)) return [];
  const languageName = language.file.language;
  const findings = [];
  const add = (rule, detail) => findings.push(new Finding(rule, detail, languageName, message));

  if (message.numerus) {
    const expected = numerusFormCount(languageName);
    if (expected !== undefined && message.numerusForms.length !== expected) {
      add('numerus-forms', `${message.numerusForms.length} forms, ${languageName} needs ${expected}`);
    }
  }

  for (const [source, text] of textPairs(message)) {
    if (!setsEqual(placeholders(source), placeholders(text))) {
      add(
        'placeholders',
        `source has ${formatPlaceholders(placeholders(source))}, translation has ${formatPlaceholders(placeholders(text))}`,
      );
    }
    if (hasMnemonic(source) !== hasMnemonic(text)) {
      add('mnemonic', `only the ${hasMnemonic(source) ? 'source' : 'translation'} has an &-mnemonic`);
    }
    const [sourceLeft, sourceRight] = edges(source);
    const [textLeft, textRight] = edges(text);
    if (sourceLeft !== textLeft || sourceRight !== textRight) {
      add('edge-whitespace', 'leading/trailing whitespace differs from the source');
    }
    if (!language.isSourceLanguage && countNewlines(source) !== countNewlines(text)) {
      add('newlines', `source has ${countNewlines(source)} line breaks, translation has ${countNewlines(text)}`);
    }
    if (!sameCounts(tags(source), tags(text))) add('markup', 'HTML tags differ from the source');

    if (text === source) {
      if (language.isSourceLanguage) add('en-identical', 'override equals the source text');
      else if (hasLetters(source) && source.trim().length >= IDENTICAL_MINIMUM_LENGTH) {
        add('identical', 'translation equals the source text');
      }
      continue;
    }
    const script = expectedScript(languageName);
    if (script === undefined) continue;
    const found = scriptsIn(text);
    const foreign = (FOREIGN_SCRIPTS[script] ?? []).filter((item) => found.has(item));
    if (foreign.length > 0) {
      add('wrong-script', `contains ${foreign.sort().join(', ')} characters`);
    } else if (script !== Script.LATIN && !found.has(script) && hasLetters(text)) {
      add('no-native-script', `no ${script} characters`);
    }
  }
  if (glossary !== null) findings.push(...checkGlossary(message, language, glossary));
  return findings;
}

/**
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {boolean}
 */
function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * @param {string} text
 * @returns {number}
 */
function countNewlines(text) {
  let count = 0;
  for (const character of text) if (character === '\n') count += 1;
  return count;
}

/**
 * Glossary terms found in the source must appear in their glossary rendering.
 * @param {import('./model.js').Message} message
 * @param {import('./context.js').LoadedLanguage} language
 * @param {import('./glossary.js').Glossary} glossary
 * @returns {Finding[]}
 */
export function checkGlossary(message, language, glossary) {
  if (language.isSourceLanguage || isDead(message) || !hasText(message)) return [];
  const languageKey = baseLanguage(language.file.language);
  const text = messageTexts(message).filter(Boolean).join('\n');
  const folded = text.toLowerCase();
  const findings = [];

  for (const termMatch of glossary.findMatches(message.source, message.context)) {
    const term = termMatch.term;
    const rendering = term.renderings[languageKey];
    if (rendering === undefined || term.exceptions.has(message.shortId)) continue;
    const avoided = rendering.avoid.find((variant) => folded.includes(variant.toLowerCase()));
    if (avoided !== undefined) {
      findings.push(
        new Finding(
          'glossary-avoid',
          `${JSON.stringify(term.term)}: uses ${JSON.stringify(avoided)}, glossary says ${JSON.stringify(rendering.translation)}`,
          language.file.language,
          message,
        ),
      );
      continue;
    }
    const keptVerbatim = termMatch.texts.some((sourceText) => text.includes(sourceText));
    rendering.pattern.lastIndex = 0;
    const matches = rendering.pattern.test(text);
    rendering.pattern.lastIndex = 0;
    if (matches || keptVerbatim) continue;
    const rule = rendering.status === Status.APPROVED ? 'glossary' : 'glossary-proposed';
    findings.push(
      new Finding(
        rule,
        `${JSON.stringify(term.term)} should be translated as ${JSON.stringify(rendering.translation)}`,
        language.file.language,
        message,
      ),
    );
  }
  return findings;
}

/**
 * State-level rules for one message.
 * @param {import('./model.js').Message} message
 * @param {import('./context.js').LoadedLanguage} language
 * @returns {Finding[]}
 */
export function checkState(message, language) {
  const languageName = language.file.language;
  if (message.translationType === 'obsolete') {
    return [new Finding('legacy-obsolete', 'type="obsolete" (Qt 4); lupdate now writes "vanished"', languageName, message)];
  }
  if (stateOf(message) === State.BLANK) {
    const fix = language.isSourceLanguage ? 'make it unfinished' : 'copy the source text or translate it';
    return [
      new Finding('blank', `finished without text, the UI shows an empty string; ${fix}`, languageName, message),
    ];
  }
  if (language.isSourceLanguage) return [];
  if (stateOf(message) === State.UNTRANSLATED) {
    return [new Finding('untranslated', 'no translation', languageName, message)];
  }
  if (stateOf(message) === State.DRAFT) {
    const detail = message.translatorComment
      ? `waiting for review: ${message.translatorComment}`
      : 'waiting for review';
    return [new Finding('draft', detail, languageName, message)];
  }
  return [];
}

/**
 * Document-level rules (formatting, duplicates, states, texts).
 * @param {import('./context.js').LoadedLanguage} language
 * @param {import('./glossary.js').Glossary|null} glossary
 * @returns {Finding[]}
 */
export function checkDocument(language, glossary = null) {
  const document = language.document;
  const findings = document.writeBlockers.map((blocker) => new Finding('write-blocked', blocker, language.file.language));
  if (document.formatDrift !== null) {
    const drift = document.formatDrift;
    findings.push(
      new Finding(
        'format-drift',
        `line ${drift.line}: file has ${JSON.stringify(drift.expected)}, lupdate format is ${JSON.stringify(drift.actual)}`,
        language.file.language,
        null,
        { line: drift.line },
      ),
    );
  }

  const keyCounts = new Map();
  for (const context of document.contexts) {
    for (const message of context.messages) {
      const key = `${message.context}\0${message.source}\0${message.comment}`;
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }
  const reported = new Set();
  let deadCount = 0;
  for (const context of document.contexts) {
    for (const message of context.messages) {
      const key = `${message.context}\0${message.source}\0${message.comment}`;
      if ((keyCounts.get(key) ?? 0) > 1 && !reported.has(key)) {
        reported.add(key);
        findings.push(
          new Finding('duplicate-key', `appears ${keyCounts.get(key)} times`, language.file.language, message),
        );
      }
      if (isDead(message)) deadCount += 1;
      findings.push(...checkState(message, language));
      findings.push(...checkText(message, language, glossary));
    }
  }
  if (deadCount > 0) {
    findings.push(
      new Finding('vanished', `${deadCount} vanished/obsolete messages; run prune`, language.file.language, null, {
        count: deadCount,
      }),
    );
  }
  return findings;
}

/**
 * Source-side rules and cross-file desync.
 * @param {Array<import('./context.js').LoadedLanguage>} languages
 * @param {{root: string, buildDirectories: readonly string[]}} layout
 * @returns {Finding[]}
 */
export function checkSources(languages, layout) {
  const findings = [];
  const firstActive = new Map();
  for (const language of languages) {
    for (const context of language.document.contexts) {
      for (const message of context.messages) {
        if (!isDead(message) && !firstActive.has(`${message.context}\0${message.source}\0${message.comment}`)) {
          firstActive.set(`${message.context}\0${message.source}\0${message.comment}`, { language, message });
        }
      }
    }
  }

  const ids = new Map();
  for (const language of languages) {
    for (const context of language.document.contexts) {
      for (const message of context.messages) {
        const key = `${message.context}\0${message.source}\0${message.comment}`;
        if (!ids.has(message.shortId)) ids.set(message.shortId, new Set());
        ids.get(message.shortId).add(key);
      }
    }
  }
  for (const [shortId, keys] of ids) {
    if (keys.size <= 1) continue;
    const listed = [...keys]
      .sort()
      .map((key) => {
        const [context, source] = key.split('\0');
        return `${context} | ${JSON.stringify(source)}`;
      })
      .join('; ');
    findings.push(new Finding('id-collision', `${shortId}: ${listed}`));
  }

  for (const { language, message } of firstActive.values()) {
    const foreign = [...scriptsIn(message.source)].filter((script) => script !== Script.LATIN);
    if (foreign.length > 0) {
      findings.push(
        new Finding('source-not-english', `source contains ${foreign.sort().join(', ')} characters`, null, message),
      );
    }
    const locations = message.locations.filter((location) => location.filename);
    if (
      locations.length > 0 &&
      locations.every((location) =>
        isBuildLocation(
          resolveLocation(language.file.path, location.filename),
          layout.root,
          layout.buildDirectories,
        ),
      )
    ) {
      findings.push(new Finding('build-only-location', 'all locations are in build trees', null, message));
    }
  }

  if (languages.length > 1) {
    for (const language of languages) {
      for (const { language: owner, message } of firstActive.values()) {
        const key = `${message.context}\0${message.source}\0${message.comment}`;
        const local = language.byKey.get(key);
        if (local !== undefined && !isDead(local)) continue;
        const state = local === undefined ? 'missing' : 'vanished';
        findings.push(
          new Finding('desync', `active in ${owner.file.language}, ${state} here`, language.file.language, message),
        );
      }
    }
  }
  return findings;
}

/**
 * Run every rule over loaded languages.
 * @param {Array<import('./context.js').LoadedLanguage>} languages
 * @param {object} options
 * @param {import('./glossary.js').Glossary|null} [options.glossary]
 * @param {string|null} [options.glossaryError]
 * @param {string} options.root
 * @param {readonly string[]} options.buildDirectories
 * @returns {Finding[]}
 */
export function runChecks(languages, options) {
  const findings = [];
  if (options.glossaryError) findings.push(new Finding('glossary-invalid', options.glossaryError));
  for (const language of languages) findings.push(...checkDocument(language, options.glossary ?? null));
  findings.push(...checkSources(languages, options));
  return findings;
}

/**
 * Whether a message is active (used by callers that filter desync findings).
 * @param {import('./model.js').Message} message
 * @returns {boolean}
 */
export function isActive(message) {
  return !isDead(message) && ACTIVE_STATES.includes(stateOf(message));
}
