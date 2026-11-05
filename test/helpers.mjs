/**
 * Shared fixture loader for the tests.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBytes } from '../lib/parse.js';
import { baseLanguage } from '../lib/project.js';
import { parseGlossary } from '../lib/glossary.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');
export const EXAMPLE_DIR = path.join(FIXTURES, 'example');
export const EDGE_DIR = path.join(FIXTURES, 'edge');

/**
 * Load one `.ts` file and build the lookup maps the tools use.
 * @param {string} filePath
 * @returns {Promise<import('../lib/context.js').LoadedLanguage>}
 */
export async function loadTranslation(filePath) {
  const bytes = await readFile(filePath);
  const document = parseBytes(bytes, filePath);
  const byId = new Map();
  const byKey = new Map();
  for (const context of document.contexts) {
    for (const message of context.messages) {
      if (!byId.has(message.shortId)) byId.set(message.shortId, []);
      byId.get(message.shortId).push(message);
      const key = `${message.context}\0${message.source}\0${message.comment}`;
      if (!byKey.has(key)) byKey.set(key, message);
    }
  }
  const sourceLanguage = document.sourceLanguage || 'en';
  return {
    file: {
      path: filePath,
      displayPath: path.relative(REPO_ROOT, filePath).split(path.sep).join('/'),
      language: document.language,
    },
    document,
    byId,
    byKey,
    isSourceLanguage: baseLanguage(document.language) === baseLanguage(sourceLanguage),
  };
}

/**
 * @param {string} name
 * @returns {Promise<import('../lib/context.js').LoadedLanguage>}
 */
export async function loadExample(name) {
  return loadTranslation(path.join(EXAMPLE_DIR, name));
}

/**
 * @returns {Promise<import('../lib/context.js').LoadedLanguage[]>}
 */
export async function loadExampleLanguages() {
  return Promise.all([
    loadExample('example_en.ts'),
    loadExample('example_ru.ts'),
    loadExample('example_zh_CN.ts'),
  ]);
}

/**
 * @returns {Promise<import('../lib/glossary.js').Glossary>}
 */
export async function loadExampleGlossary() {
  const filePath = path.join(EXAMPLE_DIR, 'glossary.json');
  return parseGlossary(await readFile(filePath, 'utf8'), filePath);
}

/**
 * @param {import('../lib/context.js').LoadedLanguage} language
 * @returns {import('../lib/model.js').Message[]}
 */
export function messagesOf(language) {
  return language.document.contexts.flatMap((context) => context.messages);
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readFixture(filePath) {
  return readFile(filePath, 'utf8');
}
