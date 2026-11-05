import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseBytes } from '../lib/parse.js';
import { serialize } from '../lib/serialize.js';
import { EXAMPLE_DIR, EDGE_DIR } from './helpers.mjs';

const FIXTURES = [
  path.join(EXAMPLE_DIR, 'example_en.ts'),
  path.join(EXAMPLE_DIR, 'example_ru.ts'),
  path.join(EXAMPLE_DIR, 'example_zh_CN.ts'),
  path.join(EDGE_DIR, 'edge_ru.ts'),
];

for (const filePath of FIXTURES) {
  test(`round-trips ${path.basename(filePath)} byte for byte`, async () => {
    const bytes = await readFile(filePath);
    const document = parseBytes(bytes, filePath);
    assert.deepEqual(document.writeBlockers, []);
    assert.equal(document.formatDrift, null);
    const produced = serialize(document);
    assert.equal(Buffer.from(produced, 'utf8').equals(bytes), true);
  });
}

test('preserves CRLF, declarations, dependencies, and extras', async () => {
  const bytes = await readFile(path.join(EDGE_DIR, 'edge_ru.ts'));
  const document = parseBytes(bytes, 'edge_ru.ts');
  assert.equal(document.newline, '\r\n');
  assert.equal(document.language, 'de_DE');
  assert.deepEqual(document.dependencies, ['qtbase_de.qm']);
  assert.deepEqual(document.extras, [['poedit', '1']]);
  const messages = document.contexts.flatMap((context) => context.messages);
  const quoted = messages.find((message) => message.source.startsWith('"Quoted"'));
  assert.ok(quoted);
  assert.equal(quoted.extraComment, 'Exercises entity escaping');
  const line = messages.find((message) => message.source === 'Line\rbreak');
  assert.ok(line);
  assert.equal(line.oldSource, 'Line break');
  assert.equal(line.userData, 'raw-user-data');
  assert.deepEqual(line.extras, [['kind', 'edge']]);
  const plural = messages.find((message) => message.numerus);
  assert.deepEqual(plural.numerusForms, ['%n Kante', '%n Kanten']);
  assert.equal(messages.filter((message) => message.translationType === 'vanished').length, 1);
});
