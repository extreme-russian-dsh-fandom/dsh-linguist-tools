import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEntries, pruneDocument } from '../lib/editing.js';
import { runChecks } from '../lib/checks.js';
import { State, isDead, stateOf, ALL_STATES } from '../lib/model.js';
import { MessageFilter, parseStates } from '../lib/query.js';
import { loadExample, loadExampleGlossary, loadExampleLanguages, messagesOf, REPO_ROOT } from './helpers.mjs';

/**
 * @param {import('../lib/context.js').LoadedLanguage} language
 * @returns {Record<string, number>}
 */
function stateCounts(language) {
  const counts = Object.fromEntries(ALL_STATES.map((state) => [state, 0]));
  for (const context of language.document.contexts) {
    for (const message of context.messages) counts[stateOf(message)] += 1;
  }
  return counts;
}

/**
 * @param {import('../lib/context.js').LoadedLanguage} language
 * @param {string} source
 * @param {string} [context]
 * @returns {import('../lib/model.js').Message}
 */
function findMessage(language, source, context) {
  const message = messagesOf(language).find(
    (candidate) => candidate.source === source && (context === undefined || candidate.context === context),
  );
  assert.ok(message, `expected message ${JSON.stringify(source)}`);
  return message;
}

test('example catalogs have the intended state mix', async () => {
  const [english, russian, chinese] = await loadExampleLanguages();
  assert.deepEqual(stateCounts(english), {
    translated: 1,
    draft: 0,
    untranslated: 17,
    blank: 0,
    vanished: 0,
  });
  assert.deepEqual(stateCounts(russian), {
    translated: 16,
    draft: 1,
    untranslated: 1,
    blank: 0,
    vanished: 1,
  });
  assert.deepEqual(stateCounts(chinese), {
    translated: 17,
    draft: 0,
    untranslated: 0,
    blank: 1,
    vanished: 0,
  });
});

test('the example glossary parses and resolves scoped terms and exceptions', async () => {
  const glossary = await loadExampleGlossary();
  assert.equal(glossary.terms.length, 8);
  const probe = glossary.terms.find((term) => term.term === 'probe');
  assert.equal(probe.renderings.ru.translation, 'щуп');
  assert.equal(probe.renderings.zh.translation, '测头');
  assert.ok(probe.exceptions.size > 0);

  const head = glossary.find('Probe head diameter', 'SettingsDialog');
  assert.ok(head.some((term) => term.term === 'probe head'));
  assert.ok(!head.some((term) => term.term === 'probe'));

  const settingsOffset = glossary.find('Offset', 'SettingsDialog');
  assert.equal(settingsOffset[0].renderings.ru.translation, 'смещение');
  const reportOffset = glossary.find('Offset', 'Report');
  assert.equal(reportOffset[0].renderings.ru.translation, 'отступ');

  const connection = glossary.find('Probe the connection', 'MainWindow');
  assert.ok(connection.some((term) => term.term === 'probe'));
  const [, russian] = await loadExampleLanguages();
  const message = findMessage(russian, 'Probe the connection');
  assert.ok(probe.exceptions.has(message.shortId));
});

test('lint reports the deliberate examples', async () => {
  const languages = await loadExampleLanguages();
  const glossary = await loadExampleGlossary();
  const findings = runChecks(languages, {
    glossary,
    glossaryError: null,
    root: REPO_ROOT,
    buildDirectories: ['build', 'out', 'dist'],
  });
  const rules = new Set(findings.map((finding) => finding.rule));
  assert.ok(rules.has('blank'), `expected blank, got ${[...rules].join(', ')}`);
  assert.ok(rules.has('untranslated'));
  assert.ok(rules.has('draft'));
  assert.ok(rules.has('vanished'));
  assert.ok(rules.has('glossary-avoid'));
  assert.ok(!rules.has('placeholders'));
  assert.ok(!rules.has('mnemonic'));
  assert.ok(!rules.has('markup'));
  assert.ok(!rules.has('glossary-invalid'));
});

test('apply resolves a draft and clears the note', async () => {
  const russian = await loadExample('example_ru.ts');
  const snapshot = findMessage(russian, 'Snapshot');
  assert.equal(stateOf(snapshot), State.DRAFT);
  const results = applyEntries(russian, [
    { line: 1, kind: 'entry', shortId: snapshot.shortId, translation: 'Снимок', state: 'finished', note: '' },
  ]);
  assert.equal(results[0].result, 'updated');
  assert.equal(stateOf(snapshot), State.TRANSLATED);
  assert.equal(snapshot.translatorComment, '');
});

test('apply identifies a message by context and source', async () => {
  const russian = await loadExample('example_ru.ts');
  const offset = findMessage(russian, 'Offset', 'SettingsDialog');
  const results = applyEntries(russian, [
    {
      line: 1,
      kind: 'entry',
      context: 'SettingsDialog',
      source: 'Offset',
      comment: '',
      translation: 'Смещение по X',
      state: 'finished',
    },
  ]);
  assert.equal(results[0].result, 'updated');
  assert.equal(offset.translation, 'Смещение по X');
});

test('apply rejects an explicit finished empty translation', async () => {
  const russian = await loadExample('example_ru.ts');
  const target = findMessage(russian, 'Tolerance');
  const results = applyEntries(russian, [
    { line: 1, kind: 'entry', shortId: target.shortId, translation: '', state: 'finished' },
  ]);
  assert.equal(results[0].result, 'rejected');
  assert.ok(results[0].issues.some((issue) => issue.rule === 'blank'));
});

test('apply rejects a placeholder change', async () => {
  const russian = await loadExample('example_ru.ts');
  const target = findMessage(russian, '%1 of %2 files processed');
  const results = applyEntries(russian, [
    { line: 1, kind: 'entry', shortId: target.shortId, translation: 'Обработано файлов' },
  ]);
  assert.equal(results[0].result, 'rejected');
  assert.ok(results[0].issues.some((issue) => issue.rule === 'placeholders'));
});

test('prune removes the vanished example and its empty context', async () => {
  const russian = await loadExample('example_ru.ts');
  assert.equal(messagesOf(russian).filter(isDead).length, 1);
  const pruned = pruneDocument(russian.document);
  assert.equal(pruned.messages.length, 1);
  assert.deepEqual(pruned.contexts.map((context) => context.name), ['LegacyDialog']);
  assert.equal(messagesOf(russian).filter(isDead).length, 0);
  assert.equal(messagesOf(russian).length, 18);
});

test('state filters default to active messages only', async () => {
  const russian = await loadExample('example_ru.ts');
  const filter = new MessageFilter({ states: parseStates(undefined) });
  const all = messagesOf(russian);
  const active = all.filter((message) => filter.matches(message));
  assert.equal(active.length, all.length - 1);
  assert.ok(active.every((message) => !isDead(message)));
});
