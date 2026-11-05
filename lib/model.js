/**
 * In-memory model of a Qt Linguist `.ts` document.
 *
 * The model mirrors the one used by the original tstools implementation: a
 * message is keyed by `(context, source, comment)`, its short id is the first
 * eight hex characters of `sha1(context \\0 source \\0 comment)`, and its state
 * is derived from the `<translation type="...">` attribute and its text.
 */

import { createHash } from 'node:crypto';

/** Number of hex characters in a message id. */
export const SHORT_ID_LENGTH = 8;

/** Minimum prefix accepted by read-side lookups. */
export const MINIMUM_ID_PREFIX_LENGTH = 4;

/** Values of the `<translation type="...">` attribute; absent means finished. */
export const TRANSLATION_TYPES = Object.freeze(['unfinished', 'vanished', 'obsolete']);

/** Translation types that no longer belong to the sources. */
export const DEAD_TYPES = Object.freeze(new Set(['vanished', 'obsolete']));

/** Derived message states. */
export const State = Object.freeze({
  TRANSLATED: 'translated',
  DRAFT: 'draft',
  UNTRANSLATED: 'untranslated',
  BLANK: 'blank',
  VANISHED: 'vanished',
});

/** States an active message can have. */
export const ACTIVE_STATES = Object.freeze([
  State.TRANSLATED,
  State.DRAFT,
  State.UNTRANSLATED,
  State.BLANK,
]);

/** Every derived state. */
export const ALL_STATES = Object.freeze([
  State.TRANSLATED,
  State.DRAFT,
  State.UNTRANSLATED,
  State.BLANK,
  State.VANISHED,
]);

/**
 * Stable short id of one message key.
 * @param {string} context
 * @param {string} source
 * @param {string} comment
 * @returns {string} eight lowercase hex characters
 */
export function makeShortId(context, source, comment) {
  return createHash('sha1').update(`${context}\0${source}\0${comment}`, 'utf8').digest('hex').slice(0, SHORT_ID_LENGTH);
}

/**
 * Create an empty message owned by a context.
 * @param {string} context
 * @param {Partial<Message>} [fields]
 * @returns {Message}
 */
export function createMessage(context, fields = {}) {
  const message = {
    context,
    source: '',
    translation: '',
    numerus: false,
    numerusForms: [],
    translationType: null,
    translationId: '',
    locations: [],
    oldSource: '',
    comment: '',
    oldComment: '',
    extraComment: '',
    translatorComment: '',
    userData: '',
    extras: [],
    shortId: '',
    ...fields,
  };
  message.shortId = makeShortId(message.context, message.source, message.comment);
  return message;
}

/**
 * @typedef {object} Location
 * @property {string|null} filename
 * @property {string|null} line
 */

/**
 * @typedef {object} Message
 * @property {string} context
 * @property {string} source
 * @property {string} translation
 * @property {boolean} numerus
 * @property {string[]} numerusForms
 * @property {string|null} translationType
 * @property {string} translationId
 * @property {Location[]} locations
 * @property {string} oldSource
 * @property {string} comment
 * @property {string} oldComment
 * @property {string} extraComment
 * @property {string} translatorComment
 * @property {string} userData
 * @property {Array<[string, string]>} extras
 * @property {string} shortId
 */

/**
 * @typedef {object} Context
 * @property {string} name
 * @property {Message[]} messages
 */

/**
 * @typedef {object} FormatDrift
 * @property {number} line
 * @property {string} expected
 * @property {string} actual
 */

/**
 * @typedef {object} TsDocument
 * @property {import('node:path').PathLike|null} path
 * @property {any} target
 * @property {string} version
 * @property {string} language
 * @property {string} sourceLanguage
 * @property {string[]} dependencies
 * @property {Array<[string, string]>} extras
 * @property {Context[]} contexts
 * @property {string} newline
 * @property {string[]} writeBlockers
 * @property {FormatDrift|null} formatDrift
 */

/**
 * Whether a message is vanished or obsolete.
 * @param {Message} message
 * @returns {boolean}
 */
export function isDead(message) {
  return DEAD_TYPES.has(message.translationType);
}

/**
 * Texts of a message: the plural forms, or the single translation.
 * @param {Message} message
 * @returns {string[]}
 */
export function messageTexts(message) {
  return message.numerus ? message.numerusForms : [message.translation];
}

/**
 * Whether a message has any non-empty text.
 * @param {Message} message
 * @returns {boolean}
 */
export function hasText(message) {
  return messageTexts(message).some((text) => text.length > 0);
}

/**
 * Derived state of a message.
 * @param {Message} message
 * @returns {string}
 */
export function stateOf(message) {
  if (isDead(message)) return State.VANISHED;
  if (message.translationType === 'unfinished') return hasText(message) ? State.DRAFT : State.UNTRANSLATED;
  return hasText(message) ? State.TRANSLATED : State.BLANK;
}

/**
 * Message key used by lupdate and by every language file.
 * @param {Message} message
 * @returns {[string, string, string]}
 */
export function messageKey(message) {
  return [message.context, message.source, message.comment];
}

/**
 * Create an empty document.
 * @param {Partial<TsDocument>} [fields]
 * @returns {TsDocument}
 */
export function createDocument(fields = {}) {
  return {
    path: null,
    target: null,
    version: '2.1',
    language: '',
    sourceLanguage: '',
    dependencies: [],
    extras: [],
    contexts: [],
    newline: '\n',
    writeBlockers: [],
    formatDrift: null,
    ...fields,
  };
}

/**
 * Iterate every message of a document.
 * @param {TsDocument} document
 * @returns {IterableIterator<Message>}
 */
export function* messagesOf(document) {
  for (const context of document.contexts) yield* context.messages;
}

/**
 * Compare two documents by content (ignoring path and formatting).
 * @param {TsDocument} a
 * @param {TsDocument} b
 * @returns {boolean}
 */
export function sameContent(a, b) {
  if (
    a.version !== b.version ||
    a.language !== b.language ||
    a.sourceLanguage !== b.sourceLanguage ||
    a.dependencies.length !== b.dependencies.length ||
    a.extras.length !== b.extras.length ||
    a.contexts.length !== b.contexts.length
  ) {
    return false;
  }
  for (let index = 0; index < a.dependencies.length; index += 1) {
    if (a.dependencies[index] !== b.dependencies[index]) return false;
  }
  for (let index = 0; index < a.extras.length; index += 1) {
    if (a.extras[index][0] !== b.extras[index][0] || a.extras[index][1] !== b.extras[index][1]) return false;
  }
  for (let index = 0; index < a.contexts.length; index += 1) {
    if (!sameContext(a.contexts[index], b.contexts[index])) return false;
  }
  return true;
}

/**
 * Compare two contexts by content.
 * @param {Context} a
 * @param {Context} b
 * @returns {boolean}
 */
export function sameContext(a, b) {
  if (a.name !== b.name || a.messages.length !== b.messages.length) return false;
  for (let index = 0; index < a.messages.length; index += 1) {
    if (!sameMessage(a.messages[index], b.messages[index])) return false;
  }
  return true;
}

const MESSAGE_FIELDS = Object.freeze([
  'context',
  'source',
  'translation',
  'numerus',
  'translationType',
  'translationId',
  'oldSource',
  'comment',
  'oldComment',
  'extraComment',
  'translatorComment',
  'userData',
]);

/**
 * Compare two messages by content.
 * @param {Message} a
 * @param {Message} b
 * @returns {boolean}
 */
export function sameMessage(a, b) {
  for (const field of MESSAGE_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  if (a.numerusForms.length !== b.numerusForms.length) return false;
  for (let index = 0; index < a.numerusForms.length; index += 1) {
    if (a.numerusForms[index] !== b.numerusForms[index]) return false;
  }
  if (a.locations.length !== b.locations.length) return false;
  for (let index = 0; index < a.locations.length; index += 1) {
    if (a.locations[index].filename !== b.locations[index].filename) return false;
    if (a.locations[index].line !== b.locations[index].line) return false;
  }
  if (a.extras.length !== b.extras.length) return false;
  for (let index = 0; index < a.extras.length; index += 1) {
    if (a.extras[index][0] !== b.extras[index][0] || a.extras[index][1] !== b.extras[index][1]) return false;
  }
  return true;
}
