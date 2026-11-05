import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseBytes, writeText } from '../lib/parse.js';
import { TsParseError } from '../lib/parse.js';
import { EDGE_DIR } from './helpers.mjs';

const load = async (name) => {
  const filePath = path.join(EDGE_DIR, name);
  return parseBytes(await readFile(filePath), filePath);
};

test('unsupported constructs become write blockers, not data loss', async () => {
  const document = await load('blocked_ru.ts');
  assert.ok(document.writeBlockers.length > 0);
  assert.ok(document.writeBlockers.some((blocker) => blocker.includes('lengthvariant')));
  assert.throws(() => writeText(document), /read-only/u);
});

test('merge conflict markers are reported with a line number', async () => {
  await assert.rejects(load('conflict_ru.ts'), (error) => {
    assert.ok(error instanceof TsParseError);
    assert.equal(error.kind, 'merge-conflict');
    assert.ok(error.line >= 1);
    return true;
  });
});

test('formatting drift is allowed and normalized on write', async () => {
  const document = await load('drift_ru.ts');
  assert.deepEqual(document.writeBlockers, []);
  assert.ok(document.formatDrift);
  const normalized = writeText(document);
  assert.ok(!normalized.includes('\n\n<context>'));
  const reparsed = parseBytes(Buffer.from(normalized, 'utf8'), 'drift_ru.ts');
  assert.deepEqual(reparsed.writeBlockers, []);
  assert.equal(reparsed.formatDrift, null);
});
