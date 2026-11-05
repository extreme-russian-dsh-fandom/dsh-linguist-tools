/**
 * Repository layout helpers: language resolution, source locations, and
 * display paths. These functions are pure; filesystem discovery lives in
 * `context.js`.
 */

import path from 'node:path';

/** Language used when a `.ts` file does not declare `sourcelanguage`. */
export const DEFAULT_SOURCE_LANGUAGE = 'en';

/** A translation-file layout error. */
export class ProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectError';
  }
}

/**
 * Primary subtag of a language name: `ru_RU` -> `ru`, `zh-Hans` -> `zh`.
 * @param {string} language
 * @returns {string}
 */
export function baseLanguage(language) {
  return language.replaceAll('-', '_').split('_')[0].toLowerCase();
}

/**
 * Meaningful language part of an lupdate-style file name: `foo_ru_RU.ts` -> `ru_RU`.
 * @param {string} filePath
 * @returns {string}
 */
export function languageFromFileName(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const separator = stem.indexOf('_');
  return separator === -1 ? stem : stem.slice(separator + 1);
}

/**
 * Whether one language spec selects one discovered file.
 * @param {string} spec
 * @param {{language: string, path: string}} file
 * @returns {boolean}
 */
export function matchesLanguage(spec, file) {
  const normalized = spec.replaceAll('-', '_').toLowerCase();
  const language = file.language.replaceAll('-', '_').toLowerCase();
  const suffix = path.basename(file.path, path.extname(file.path)).toLowerCase().split('_').slice(1).join('_');
  return normalized === language || normalized === baseLanguage(language) || normalized === suffix;
}

/**
 * Resolve `all`, `ru`, `zh_CN`, `ru,zh` into discovered language files.
 * @param {string} spec
 * @param {Array<{language: string, path: string}>} available
 * @returns {Array<{language: string, path: string}>}
 */
export function resolveLanguageFiles(spec, available) {
  if (available.length === 0) throw new ProjectError('no .ts files found in the translations directory');
  const trimmed = spec.trim();
  if (trimmed.toLowerCase() === 'all') return [...available];
  const requested = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (requested.length === 0) throw new ProjectError('no language given');

  const resolved = [];
  for (const item of requested) {
    const candidates = available.filter((file) => matchesLanguage(item, file));
    if (candidates.length === 0) {
      const known = available.map((file) => file.language).join(', ');
      throw new ProjectError(`unknown language ${JSON.stringify(item)}; available: ${known}`);
    }
    if (candidates.length > 1) {
      const names = candidates.map((file) => file.language).join(', ');
      throw new ProjectError(`ambiguous language ${JSON.stringify(item)}; candidates: ${names}`);
    }
    if (!resolved.includes(candidates[0])) resolved.push(candidates[0]);
  }
  return resolved;
}

/**
 * Resolve a `<location filename="...">` relative to the `.ts` file.
 * @param {string} translationPath
 * @param {string} filename
 * @returns {string}
 */
export function resolveLocation(translationPath, filename) {
  return path.resolve(path.dirname(translationPath), filename);
}

/**
 * Render a path relative to the project root when it is inside it.
 * @param {string} filePath
 * @param {string} root
 * @returns {string}
 */
export function displayPath(filePath, root) {
  const relative = path.relative(root, filePath);
  if (relative.length === 0) return '.';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  return filePath.split(path.sep).join('/');
}

/**
 * Whether a source location lies in a generated build tree.
 * @param {string} filePath
 * @param {string} root
 * @param {readonly string[]} buildDirectories
 * @returns {boolean}
 */
export function isBuildLocation(filePath, root, buildDirectories) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return buildDirectories.includes(first);
}
