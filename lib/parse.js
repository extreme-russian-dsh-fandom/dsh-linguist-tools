/**
 * `.ts` document loading: tolerant parsing, write blockers, and format drift.
 *
 * A document is writable only when every construct can be reproduced by
 * `serialize.js`. Formatting-only deviations are reported as `formatDrift` and
 * are normalized by the next successful write, exactly as `lupdate` would.
 */

import { parseXml, XmlParseError } from './xml.js';
import { serialize } from './serialize.js';
import { createDocument, createMessage, makeShortId, sameContent } from './model.js';

const MERGE_MARKER = /^(<{7}|>{7})(?: |$)/gmu;
const EXTRA_PREFIX = 'extra-';
const DRIFT_PREVIEW_LENGTH = 160;
const MAX_BLOCKER_LENGTH = 500;

/** Kinds of parse failures. */
export const ParseErrorKind = Object.freeze({
  IO: 'io',
  ENCODING: 'encoding',
  MERGE_CONFLICT: 'merge-conflict',
  XML: 'malformed-xml',
  STRUCTURE: 'structure',
});

/**
 * A `.ts` file that cannot be read or interpreted.
 */
export class TsParseError extends Error {
  /**
   * @param {string|null} path
   * @param {string} kind
   * @param {string} message
   * @param {number|null} [line]
   */
  constructor(path, kind, message, line = null) {
    super(`${path ?? '<ts>'}${line === null ? '' : `:${line}`}: ${message}`);
    this.name = 'TsParseError';
    this.path = path;
    this.kind = kind;
    this.line = line;
  }
}

/**
 * @param {string|null} text
 * @returns {number}
 */
function byteValue(text) {
  if (!text) throw new Error('empty <byte> value');
  if (text[0] === 'x' || text[0] === 'X') return Number.parseInt(text.slice(1), 16);
  return Number.parseInt(text, 10);
}

class Builder {
  /**
   * @param {string|null} path
   */
  constructor(path) {
    this.path = path;
    /** @type {string[]} */
    this.blockers = [];
  }

  /**
   * @param {string} where
   * @param {string} reason
   */
  block(where, reason) {
    this.blockers.push(`${where}: ${reason}`.slice(0, MAX_BLOCKER_LENGTH));
  }

  /**
   * @param {{attributes: Record<string, string>, name: string}} element
   * @param {readonly string[]} allowed
   * @param {string} where
   */
  checkAttributes(element, allowed, where) {
    for (const name of Object.keys(element.attributes)) {
      if (!allowed.includes(name)) this.block(where, `unsupported attribute ${JSON.stringify(name)} on <${element.name}>`);
    }
  }

  /**
   * @param {any} element
   * @param {string} where
   * @returns {string}
   */
  textOf(element, where) {
    let output = '';
    for (const child of element.children) {
      if (child.type === 'text') {
        output += child.text;
        continue;
      }
      if (child.name === 'byte') {
        try {
          output += String.fromCodePoint(byteValue(child.attributes.value));
        } catch (error) {
          this.block(where, `bad <byte> element: ${error.message}`);
        }
        continue;
      }
      this.block(where, `unsupported element <${child.name}> inside <${element.name}>`);
    }
    return output;
  }

  /**
   * @param {any} root
   * @returns {import('./model.js').TsDocument}
   */
  buildDocument(root) {
    if (root.name !== 'TS') {
      throw new TsParseError(this.path, ParseErrorKind.STRUCTURE, `root element is <${root.name}>, expected <TS>`);
    }
    this.checkAttributes(root, ['version', 'language', 'sourcelanguage'], '<TS>');
    const document = createDocument({
      path: null,
      version: root.attributes.version ?? '',
      language: root.attributes.language ?? '',
      sourceLanguage: root.attributes.sourcelanguage ?? '',
    });

    for (const child of root.children) {
      if (child.type === 'text') continue;
      if (child.name === 'context') {
        document.contexts.push(this.buildContext(child));
      } else if (child.name === 'dependencies') {
        const collect = (element) => {
          for (const nested of element.children) {
            if (nested.type !== 'element') continue;
            if (nested.name === 'dependency') document.dependencies.push(nested.attributes.catalog ?? '');
            collect(nested);
          }
        };
        collect(child);
      } else if (child.name.startsWith(EXTRA_PREFIX)) {
        document.extras.push([child.name.slice(EXTRA_PREFIX.length), this.textOf(child, '<TS>')]);
      } else {
        this.block('<TS>', `unsupported element <${child.name}>`);
      }
    }
    return document;
  }

  /**
   * @param {any} element
   * @returns {import('./model.js').Context}
   */
  buildContext(element) {
    const nameElement = element.children.find((child) => child.type === 'element' && child.name === 'name');
    if (nameElement === undefined) {
      throw new TsParseError(this.path, ParseErrorKind.STRUCTURE, '<context> without <name>');
    }
    const context = { name: this.textOf(nameElement, '<context>'), messages: [] };
    const where = `context ${JSON.stringify(context.name)}`;
    for (const child of element.children) {
      if (child.type === 'text') continue;
      if (child.name === 'message') {
        context.messages.push(this.buildMessage(child, context.name));
      } else if (child.name !== 'name') {
        this.block(where, `unsupported element <${child.name}>`);
      }
    }
    return context;
  }

  /**
   * @param {any} element
   * @param {string} contextName
   * @returns {import('./model.js').Message}
   */
  buildMessage(element, contextName) {
    this.checkAttributes(element, ['id', 'numerus'], `context ${JSON.stringify(contextName)}`);
    const message = createMessage(contextName, {
      numerus: element.attributes.numerus === 'yes',
      translationId: element.attributes.id ?? '',
    });
    const where = `context ${JSON.stringify(contextName)}, message`;
    const textFields = {
      source: 'source',
      oldsource: 'oldSource',
      comment: 'comment',
      oldcomment: 'oldComment',
      extracomment: 'extraComment',
      translatorcomment: 'translatorComment',
      userdata: 'userData',
    };
    let hasSource = false;

    for (const child of element.children) {
      if (child.type === 'text') continue;
      if (child.name === 'location') {
        this.checkAttributes(child, ['filename', 'line'], where);
        message.locations.push({
          filename: child.attributes.filename ?? null,
          line: child.attributes.line ?? null,
        });
      } else if (Object.hasOwn(textFields, child.name)) {
        message[textFields[child.name]] = this.textOf(child, where);
        if (child.name === 'source') hasSource = true;
      } else if (child.name === 'translation') {
        this.readTranslation(child, message, where);
      } else if (child.name.startsWith(EXTRA_PREFIX)) {
        message.extras.push([child.name.slice(EXTRA_PREFIX.length), this.textOf(child, where)]);
      } else {
        this.block(where, `unsupported element <${child.name}>`);
      }
    }
    if (!hasSource) this.block(where, 'message without <source>');
    message.shortId = makeShortId(message.context, message.source, message.comment);
    return message;
  }

  /**
   * @param {any} element
   * @param {import('./model.js').Message} message
   * @param {string} where
   */
  readTranslation(element, message, where) {
    this.checkAttributes(element, ['type'], where);
    const type = element.attributes.type;
    if (type !== undefined && !['unfinished', 'vanished', 'obsolete'].includes(type)) {
      this.block(where, `unknown translation type ${JSON.stringify(type)}`);
    }
    message.translationType = type ?? null;
    if (!message.numerus) {
      message.translation = this.textOf(element, where);
      return;
    }
    const leading = element.children
      .filter((child) => child.type === 'text')
      .map((child) => child.text)
      .join('');
    if (leading.trim().length > 0) this.block(where, 'text outside <numerusform> in a numerus translation');
    for (const child of element.children) {
      if (child.type === 'text') continue;
      if (child.name === 'numerusform') {
        this.checkAttributes(child, [], where);
        message.numerusForms.push(this.textOf(child, where));
      } else {
        this.block(where, `unsupported element <${child.name}> in a numerus translation`);
      }
    }
  }
}

/**
 * Locate the first line where two serializations differ.
 * @param {string} original
 * @param {string} produced
 * @returns {import('./model.js').FormatDrift|null}
 */
export function findFormatDrift(original, produced) {
  if (original === produced) return null;
  const separator = original.includes('\r\n') ? '\r\n' : '\n';
  const originalLines = original.split(separator);
  const producedLines = produced.split(separator);
  const count = Math.max(originalLines.length, producedLines.length);
  for (let index = 0; index < count; index += 1) {
    const expected = index < originalLines.length ? originalLines[index] : '<end of file>';
    const actual = index < producedLines.length ? producedLines[index] : '<end of file>';
    if (expected !== actual) {
      return {
        line: index + 1,
        expected: expected.slice(0, DRIFT_PREVIEW_LENGTH),
        actual: actual.slice(0, DRIFT_PREVIEW_LENGTH),
      };
    }
  }
  return null;
}

/**
 * Describe one drift, matching the original CLI wording.
 * @param {import('./model.js').FormatDrift} drift
 * @returns {string}
 */
export function describeDrift(drift) {
  return `line ${drift.line}: file has ${JSON.stringify(drift.expected)}, lupdate format is ${JSON.stringify(drift.actual)}`;
}

/**
 * Decode and parse one `.ts` file.
 * @param {string} text
 * @param {string|null} [path]
 * @param {boolean} [checkDrift]
 * @returns {import('./model.js').TsDocument}
 */
export function parseText(text, path = null, checkDrift = true) {
  const original = text;
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;

  const markers = [...content.matchAll(MERGE_MARKER)].map((match) => {
    let line = 1;
    for (let index = 0; index < match.index; index += 1) {
      if (content[index] === '\n') line += 1;
    }
    return line;
  });
  if (markers.length > 0) {
    const listed = markers.slice(0, 10).map(String).join(', ');
    throw new TsParseError(path, ParseErrorKind.MERGE_CONFLICT, `git merge conflict markers at lines ${listed}`, markers[0]);
  }

  let root;
  try {
    root = parseXml(content, path ?? undefined);
  } catch (error) {
    if (error instanceof XmlParseError) {
      throw new TsParseError(path, ParseErrorKind.XML, `malformed XML: ${error.message}`, error.line);
    }
    throw error;
  }

  const builder = new Builder(path);
  const document = builder.buildDocument(root);
  document.path = path;
  document.newline = original.includes('\r\n') ? '\r\n' : '\n';
  document.writeBlockers = builder.blockers;

  if (document.writeBlockers.length > 0 || !checkDrift) return document;

  const produced = serialize(document);
  document.formatDrift = findFormatDrift(original, produced);
  if (document.formatDrift !== null) {
    let reparsed;
    try {
      reparsed = parseText(produced, path, false);
    } catch (error) {
      document.writeBlockers.push(`serializer produced unparseable output: ${error.message}`);
      return document;
    }
    if (!sameContent(reparsed, document)) {
      document.writeBlockers.push(`serializer does not preserve content, first difference at ${describeDrift(document.formatDrift)}`);
    }
  }
  return document;
}

/**
 * Parse `.ts` bytes, reporting encoding errors with a line number.
 * @param {Uint8Array} bytes
 * @param {string|null} [path]
 * @returns {import('./model.js').TsDocument}
 */
export function parseBytes(bytes, path = null) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TsParseError(path, ParseErrorKind.ENCODING, `invalid UTF-8: ${error.message}`, 1);
  }
  return parseText(text, path);
}

/**
 * Build the writable text of a document.
 * @param {import('./model.js').TsDocument} document
 * @returns {string}
 */
export function writeText(document) {
  if (document.writeBlockers.length > 0) {
    throw new Error(`document is read-only: ${document.writeBlockers.join('; ')}`);
  }
  return serialize(document);
}
