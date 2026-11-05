/**
 * Serializer reproducing `lupdate`'s output byte for byte.
 *
 * This is a direct port of Qt's `qttools/linguist/shared/ts.cpp` (`saveTS()` /
 * `protect()`) as used by the original Python implementation. Keeping the
 * formatting identical is what makes translation diffs minimal.
 */

const ESCAPES = Object.freeze({
  '"': '&quot;',
  '&': '&amp;',
  '>': '&gt;',
  '<': '&lt;',
  "'": '&apos;',
});

const SPACE_CATEGORIES = /[\p{Zs}\p{Zl}\p{Zp}]/u;

/**
 * Whether a code point is a space that Qt writes as a numeric entity.
 * @param {string} character
 * @returns {boolean}
 */
function needsNumericEntity(character) {
  if (character === '\n' || character === '\t') return false;
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20) return true;
  return code > 0x7f && (code === 0x85 || SPACE_CATEGORIES.test(character));
}

/**
 * Escape text the way lupdate's `protect()` does.
 * @param {string} text
 * @returns {string}
 */
export function protect(text) {
  let output = '';
  for (const character of text) {
    const escape = ESCAPES[character];
    if (escape !== undefined) {
      output += escape;
      continue;
    }
    if (needsNumericEntity(character)) {
      const code = character.codePointAt(0) ?? 0;
      output += code <= 0x20 ? `<byte value="x${code.toString(16)}"/>` : `&#x${code.toString(16)};`;
      continue;
    }
    output += character;
  }
  return output;
}

/**
 * @param {Array<[string, string]>} extras
 * @param {string} indent
 * @returns {string[]}
 */
function extrasLines(extras, indent) {
  return extras
    .map(([name, value]) => `<extra-${name}>${protect(value)}</extra-${name}>`)
    .sort()
    .map((line) => `${indent}${line}\n`);
}

/**
 * @param {import('./model.js').Message} message
 * @returns {string[]}
 */
function messageLines(message) {
  const out = ['    <message'];
  if (message.translationId) out.push(` id="${message.translationId}"`);
  if (message.numerus) out.push(' numerus="yes"');
  out.push('>\n');

  for (const location of message.locations) {
    out.push('        <location');
    if (location.filename !== null && location.filename !== undefined) out.push(` filename="${location.filename}"`);
    if (location.line !== null && location.line !== undefined) out.push(` line="${location.line}"`);
    out.push('/>\n');
  }

  out.push(`        <source>${protect(message.source)}</source>\n`);
  const optional = [
    ['oldsource', message.oldSource],
    ['comment', message.comment],
    ['oldcomment', message.oldComment],
    ['extracomment', message.extraComment],
    ['translatorcomment', message.translatorComment],
  ];
  for (const [tag, value] of optional) {
    if (value) out.push(`        <${tag}>${protect(value)}</${tag}>\n`);
  }

  out.push('        <translation');
  if (message.translationType !== null && message.translationType !== undefined) {
    out.push(` type="${message.translationType}"`);
  }
  out.push('>');
  if (message.numerus) {
    for (const form of message.numerusForms) {
      out.push(`\n            <numerusform>${protect(form)}</numerusform>`);
    }
    out.push('\n        ');
  } else {
    out.push(protect(message.translation));
  }
  out.push('</translation>\n');

  out.push(...extrasLines(message.extras, '        '));
  if (message.userData) out.push(`        <userdata>${message.userData}</userdata>\n`);
  out.push('    </message>\n');
  return out;
}

/**
 * Serialize a document.
 * @param {import('./model.js').TsDocument} document
 * @returns {string}
 */
export function serialize(document) {
  const out = ['<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE TS>\n', `<TS version="${document.version}"`];
  if (document.language && document.language !== 'C') out.push(` language="${document.language}"`);
  if (document.sourceLanguage && document.sourceLanguage !== 'C') out.push(` sourcelanguage="${document.sourceLanguage}"`);
  out.push('>\n');

  if (document.dependencies.length > 0) {
    out.push('<dependencies>\n');
    for (const catalog of document.dependencies) out.push(`<dependency catalog="${catalog}"/>\n`);
    out.push('</dependencies>\n');
  }
  out.push(...extrasLines(document.extras, '    '));

  for (const context of document.contexts) {
    out.push(`<context>\n    <name>${protect(context.name)}</name>\n`);
    for (const message of context.messages) out.push(...messageLines(message));
    out.push('</context>\n');
  }
  out.push('</TS>\n');

  const text = out.join('');
  return document.newline === '\n' ? text : text.replaceAll('\n', document.newline);
}
