/**
 * Small tolerant XML parser for Qt Linguist `.ts` files.
 *
 * Qt writes a deliberately simple XML shape: a prolog, `<!DOCTYPE TS>`, and
 * elements with quoted attributes, text, numeric character references, and the
 * occasional `<byte value="x.."/>` child. The parser builds a plain tree; the
 * document builder in `parse.js` decides which constructs it can reproduce.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * A syntax error with a source line.
 */
export class XmlParseError extends Error {
  /**
   * @param {string|undefined} path
   * @param {string} message
   * @param {number|null} [line]
   */
  constructor(path, message, line = null) {
    super(`${path ?? '<xml>'}:${line ?? '?'}: ${message}`);
    this.name = 'XmlParseError';
    this.path = path;
    this.line = line;
  }
}

/**
 * Decode XML character and named entities in one text or attribute value.
 * @param {string} raw
 * @param {(message: string) => never} fail
 * @returns {string}
 */
function decodeEntities(raw, fail) {
  if (!raw.includes('&')) return raw;
  let output = '';
  let index = 0;
  while (index < raw.length) {
    const ampersand = raw.indexOf('&', index);
    if (ampersand === -1) {
      output += raw.slice(index);
      break;
    }
    output += raw.slice(index, ampersand);
    const semicolon = raw.indexOf(';', ampersand + 1);
    if (semicolon === -1) fail('unterminated entity reference');
    const body = raw.slice(ampersand + 1, semicolon);
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) fail(`invalid character reference &${body};`);
      output += String.fromCodePoint(code);
    } else if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) fail(`invalid character reference &${body};`);
      output += String.fromCodePoint(code);
    } else if (Object.hasOwn(NAMED_ENTITIES, body)) {
      output += NAMED_ENTITIES[body];
    } else {
      fail(`unknown entity &${body};`);
    }
    index = semicolon + 1;
  }
  return output;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

/**
 * XML line-ending normalization: CRLF and lone CR become LF in character data.
 * Character references are decoded after this step, so `&#13;` stays a CR.
 * @param {string} value
 * @returns {string}
 */
function normalizeNewlines(value) {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/**
 * Parse a `.ts` document.
 * @param {string} text
 * @param {string} [path]
 * @returns {{type: 'element', name: string, attributes: Record<string, string>, children: any[]}}
 */
export function parseXml(text, path = undefined) {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const length = source.length;
  let position = 0;

  const lineOf = (offset) => {
    let line = 1;
    for (let index = 0; index < offset && index < length; index += 1) {
      if (source[index] === '\n') line += 1;
    }
    return line;
  };

  const fail = (message, offset = position) => {
    throw new XmlParseError(path, message, lineOf(offset));
  };

  const startsWith = (value, offset = position) => source.startsWith(value, offset);

  const skipWhitespace = () => {
    while (position < length && /\s/u.test(source[position])) position += 1;
  };

  const skipUntil = (terminator, offset = position) => {
    const found = source.indexOf(terminator, offset);
    if (found === -1) fail(`unterminated ${terminator}`, offset);
    return found + terminator.length;
  };

  const skipMisc = () => {
    for (;;) {
      skipWhitespace();
      if (startsWith('<!--')) {
        position = skipUntil('-->', position + 4);
      } else if (startsWith('<?')) {
        position = skipUntil('?>', position + 2);
      } else if (startsWith('<!DOCTYPE', position) || startsWith('<!doctype', position)) {
        position = skipDoctype();
      } else if (startsWith('<!')) {
        position = skipUntil('>', position + 2);
      } else {
        return;
      }
    }
  };

  const skipDoctype = () => {
    let index = position + 2;
    let bracketDepth = 0;
    let quote = '';
    while (index < length) {
      const character = source[index];
      if (quote !== '') {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '[') {
        bracketDepth += 1;
      } else if (character === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (character === '>' && bracketDepth === 0) {
        return index + 1;
      }
      index += 1;
    }
    return fail('unterminated <!DOCTYPE>', position);
  };

  const readName = () => {
    const start = position;
    if (position >= length || !NAME_START.test(source[position])) fail('expected an element name');
    position += 1;
    while (position < length && NAME_CHAR.test(source[position])) position += 1;
    return source.slice(start, position);
  };

  const skipComment = () => {
    if (!startsWith('<!--')) return false;
    position = skipUntil('-->', position + 4);
    return true;
  };

  const parseElement = () => {
    if (source[position] !== '<') fail('expected "<"');
    position += 1;
    const name = readName();
    /** @type {Record<string, string>} */
    const attributes = {};
    for (;;) {
      skipWhitespace();
      if (startsWith('/>')) {
        position += 2;
        return { type: 'element', name, attributes, children: [] };
      }
      if (startsWith('>')) {
        position += 1;
        break;
      }
      const attributeName = readName();
      skipWhitespace();
      if (source[position] !== '=') fail(`attribute ${attributeName} has no value`);
      position += 1;
      skipWhitespace();
      const quote = source[position];
      if (quote !== '"' && quote !== "'") fail(`attribute ${attributeName} is not quoted`);
      position += 1;
      const valueStart = position;
      let value = '';
      while (position < length && source[position] !== quote) {
        if (source[position] === '<') fail(`attribute ${attributeName} contains "<"`);
        position += 1;
      }
      if (position >= length) fail('unterminated attribute value');
      value = source.slice(valueStart, position);
      position += 1;
      attributes[attributeName] = decodeEntities(normalizeNewlines(value), (message) => fail(message, valueStart));
    }

    const children = [];
    for (;;) {
      if (position >= length) fail(`unexpected end of file inside <${name}>`, position);
      if (startsWith('</')) {
        position += 2;
        const closing = readName();
        skipWhitespace();
        if (source[position] !== '>') fail(`expected ">" after closing </${closing}>`);
        position += 1;
        if (closing !== name) fail(`closing </${closing}> does not match <${name}>`, position);
        return { type: 'element', name, attributes, children };
      }
      if (startsWith('<!--')) {
        skipComment();
        continue;
      }
      if (startsWith('<![CDATA[')) {
        const end = skipUntil(']]>', position + 9);
        children.push({ type: 'text', text: normalizeNewlines(source.slice(position + 9, end - 3)) });
        position = end;
        continue;
      }
      if (startsWith('<?')) {
        position = skipUntil('?>', position + 2);
        continue;
      }
      if (startsWith('<!')) {
        position = skipUntil('>', position + 2);
        continue;
      }
      if (source[position] === '<') {
        children.push(parseElement());
        continue;
      }
      const textStart = position;
      while (position < length && source[position] !== '<') position += 1;
      const raw = source.slice(textStart, position);
      children.push({ type: 'text', text: decodeEntities(normalizeNewlines(raw), (message) => fail(message, textStart)) });
    }
  };

  skipMisc();
  if (position >= length) fail('no root element');
  const root = parseElement();
  skipMisc();
  if (position < length) fail('unexpected content after the root element');
  return root;
}
