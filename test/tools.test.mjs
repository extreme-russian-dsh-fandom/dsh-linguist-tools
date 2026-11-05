import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';
import { EXAMPLE_DIR, REPO_ROOT } from './helpers.mjs';

/**
 * @param {string} target
 * @returns {Promise<any>}
 */
async function statOrUndefined(target) {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

/**
 * Minimal `ctx.fs` implementation over node:fs for the tool tests.
 */
const fakeFs = {
  sandboxMode: undefined,
  async resolve(filePath, options = {}) {
    const absolute = path.resolve(options.cwd ?? process.cwd(), filePath);
    return { targetKey: absolute, displayPath: absolute, path: absolute };
  },
  processPath(target) {
    return target.path;
  },
  async stat(target) {
    const info = await statOrUndefined(target.path);
    if (info === undefined) return undefined;
    return {
      version: `${info.mtimeMs}:${info.size}`,
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
    };
  },
  async listDir(target) {
    const entries = await readdir(target.path, { withFileTypes: true });
    return entries
      .map((entry) => {
        const child = path.join(target.path, entry.name);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          target: { targetKey: child, displayPath: child, path: child },
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  },
  async readByteRange(target, range) {
    const bytes = await readFile(target.path);
    return bytes.subarray(range.offset, range.offset + range.length);
  },
  async readBytes(target, _signal, maxBytes) {
    const bytes = await readFile(target.path);
    if (bytes.length > maxBytes) throw new Error('file is too large');
    return bytes;
  },
  async readText(target) {
    return readFile(target.path, 'utf8');
  },
  async writeText(target, content) {
    const before = await readFile(target.path, 'utf8').catch(() => null);
    await writeFile(target.path, content, 'utf8');
    const info = await stat(target.path);
    return {
      operation: before === null ? 'create' : 'update',
      version: `${info.mtimeMs}:${info.size}`,
      before,
      after: content,
    };
  },
};

/**
 * @returns {any}
 */
function fakeContext() {
  /** @type {Map<string, any>} */
  const tools = new Map();
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    fs: fakeFs,
    workingDirectory: { async ensure() { return REPO_ROOT; } },
    get() {
      return undefined;
    },
    effect(callback) {
      callback();
    },
    emit() {},
    async waterfall(_name, _target, _exec, fallback) {
      return fallback();
    },
    toolsMap: tools,
  };
}

/**
 * @param {any} ctx
 * @param {string} name
 * @param {object} args
 * @returns {Promise<any>}
 */
async function call(ctx, name, args) {
  const definition = ctx.toolsMap.get(name);
  assert.ok(definition, `tool ${name} is registered`);
  return definition.execute(args, {
    signal: new AbortController().signal,
    callId: 'test',
    name,
    arguments: args,
    agent: { id: 'test-agent' },
  });
}

test('registers the qt_ts tools', () => {
  const ctx = fakeContext();
  apply(ctx, {});
  const names = [...ctx.toolsMap.keys()].sort();
  assert.deepEqual(names, [
    'qt_ts_apply',
    'qt_ts_find',
    'qt_ts_glossary',
    'qt_ts_lint',
    'qt_ts_memory',
    'qt_ts_prune',
    'qt_ts_show',
    'qt_ts_status',
  ]);
});

test('status, find, show, memory, and glossary run on the examples', async () => {
  const ctx = fakeContext();
  apply(ctx, {});

  const status = await call(ctx, 'qt_ts_status', { dir: EXAMPLE_DIR, lang: 'all' });
  assert.equal(status.found, true, JSON.stringify(status));
  assert.equal(status.files.length, 3);
  const russian = status.files.find((file) => file.lang === 'ru_RU');
  assert.equal(russian.messages, 19);
  assert.equal(russian.draft, 1);
  assert.equal(russian.untranslated, 1);
  assert.equal(russian.vanished, 1);

  const found = await call(ctx, 'qt_ts_find', { dir: EXAMPLE_DIR, lang: 'ru', state: 'translated', limit: 2 });
  assert.equal(found.records.length, 2);
  const id = found.records[0].id;

  const shown = await call(ctx, 'qt_ts_show', { dir: EXAMPLE_DIR, ids: [id], code: 2 });
  assert.equal(shown.records.length, 1);
  assert.ok(shown.records[0].translations.ru_RU);
  assert.ok(shown.records[0].code.length > 0);
  assert.ok(shown.records[0].code[0].lines.join('\n').includes('setWindowTitle'));

  const memory = await call(ctx, 'qt_ts_memory', { dir: EXAMPLE_DIR, lang: 'ru', text: 'Welcome to Example Studio' });
  assert.ok(memory.queries[0].matches.length > 0);

  const glossary = await call(ctx, 'qt_ts_glossary', { dir: EXAMPLE_DIR, text: 'Probe head' });
  assert.ok(glossary.queries[0].terms.some((term) => term.term === 'probe head'));

  const rules = await call(ctx, 'qt_ts_lint', { dir: EXAMPLE_DIR, lang: 'ru', list_rules: true });
  assert.ok(rules.rules.some((rule) => rule.rule === 'placeholders'));

  const lint = await call(ctx, 'qt_ts_lint', { dir: EXAMPLE_DIR, lang: 'zh', severity: 'error', limit: 0 });
  assert.ok(lint.findings.some((finding) => finding.rule === 'blank'));
});

test('apply is all-or-nothing and writes valid batches', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'linguist-tools-'));
  try {
    const copy = path.join(directory, 'catalog_ru.ts');
    await copyFile(path.join(EXAMPLE_DIR, 'example_ru.ts'), copy);
    const ctx = fakeContext();
    apply(ctx, {});

    const listed = await call(ctx, 'qt_ts_find', { dir: directory, lang: 'ru', state: 'translated', limit: 0 });
    const simple = listed.records.find(
      (record) => !record.numerus && !record.source.includes('%') && !record.source.includes('&'),
    );
    const placeholder = listed.records.find((record) => record.source.includes('%1'));
    assert.ok(simple);
    assert.ok(placeholder);

    const before = await readFile(copy, 'utf8');
    const blocked = await call(ctx, 'qt_ts_apply', {
      dir: directory,
      lang: 'ru',
      entries: [
        { id: simple.id, translation: 'Тестовый перевод', state: 'finished' },
        { id: placeholder.id, translation: 'Без подстановки' },
      ],
    });
    assert.equal(blocked.summary.blocked, true);
    assert.equal(blocked.summary.written, false);
    assert.equal(await readFile(copy, 'utf8'), before);

    const written = await call(ctx, 'qt_ts_apply', {
      dir: directory,
      lang: 'ru',
      entries: [{ id: simple.id, translation: 'Тестовый перевод', state: 'finished' }],
    });
    assert.equal(written.summary.rejected, 0);
    assert.equal(written.summary.written, true);
    const after = await readFile(copy, 'utf8');
    assert.notEqual(after, before);
    assert.ok(after.includes('Тестовый перевод'));

    const status = await call(ctx, 'qt_ts_status', { dir: directory, lang: 'ru' });
    assert.equal(status.files[0].format_drift, null);
    assert.deepEqual(status.files[0].write_blockers, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prune previews by default and removes vanished messages on write', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'linguist-tools-prune-'));
  try {
    const copy = path.join(directory, 'example_ru.ts');
    await copyFile(path.join(EXAMPLE_DIR, 'example_ru.ts'), copy);
    const ctx = fakeContext();
    apply(ctx, {});

    const before = await readFile(copy, 'utf8');
    const preview = await call(ctx, 'qt_ts_prune', { dir: directory, lang: 'ru', list: true });
    assert.equal(preview.summary.dry_run, true);
    assert.equal(preview.files[0].removed_messages, 1);
    assert.equal(preview.files[0].messages[0].source, 'Legacy option');
    assert.equal(await readFile(copy, 'utf8'), before);

    const written = await call(ctx, 'qt_ts_prune', { dir: directory, lang: 'ru', dry_run: false });
    assert.equal(written.files[0].removed_messages, 1);
    assert.equal(written.files[0].written, true);
    const after = await readFile(copy, 'utf8');
    assert.ok(after.length < before.length);
    assert.ok(!after.includes('Legacy option'));
    assert.ok(!after.includes('LegacyDialog'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
