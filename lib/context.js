/**
 * Runtime layer between the tools and the DSH filesystem seam.
 *
 * Every file operation goes through `ctx.fs`, so the session's sandbox policy
 * and the read-before-write observation policy apply. Paths resolve against the
 * session's current directory when one is available.
 */

import path from 'node:path';

import { parseBytes, TsParseError, writeText } from './parse.js';
import { parseGlossary } from './glossary.js';
import {
  DEFAULT_SOURCE_LANGUAGE,
  ProjectError,
  baseLanguage,
  displayPath,
  languageFromFileName,
  resolveLanguageFiles,
} from './project.js';

const LANGUAGE_ATTRIBUTE = /<TS\b[^>]*\blanguage="([^"]*)"/u;
const HEADER_BYTES = 1024;

/**
 * A `.ts` file discovered in a translations directory.
 * @typedef {object} DiscoveredFile
 * @property {string} path absolute process path
 * @property {string} displayPath project-relative path
 * @property {string} language
 * @property {any} target DSH filesystem target
 */

/**
 * A loaded language file.
 * @typedef {object} LoadedLanguage
 * @property {DiscoveredFile} file
 * @property {import('./model.js').TsDocument} document
 * @property {Map<string, import('./model.js').Message[]>} byId
 * @property {Map<string, import('./model.js').Message>} byKey
 * @property {boolean} isSourceLanguage
 */

/**
 * @param {string} message
 * @param {number} [offset]
 */
function decodeHeader(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

export class Runtime {
  /**
   * @param {object} options
   * @param {any} options.ctx Cordis plugin context
   * @param {ReturnType<import('./config.js').resolveConfig>} options.config
   * @param {any} options.exec tool execution context
   */
  constructor({ ctx, config, exec }) {
    this.ctx = ctx;
    this.config = config;
    this.exec = exec;
    this.signal = exec?.signal;
    this._cwd = null;
  }

  get fs() {
    return this.ctx.fs;
  }

  /**
   * The session's current directory, falling back to the process directory.
   * @returns {Promise<string>}
   */
  async cwd() {
    if (this._cwd !== null) return this._cwd;
    const agent = this.exec?.agent;
    if (agent !== undefined) {
      try {
        const value = await this.ctx.workingDirectory.ensure(agent, this.signal);
        if (typeof value === 'string' && value.length > 0) {
          this._cwd = value;
          return value;
        }
      } catch {
        // Fall through to the process directory.
      }
    }
    this._cwd = process.cwd();
    return this._cwd;
  }

  /**
   * The policy to stamp on a mutation, when the mounted filesystem confines.
   * @returns {object|undefined}
   */
  policy() {
    if (this.fs.sandboxMode === undefined) return undefined;
    const service = this.ctx.get('sandboxPolicy');
    if (service === undefined) return undefined;
    const session = this.exec?.agent?.session;
    return service.resolve(session === undefined ? {} : { session });
  }

  /**
   * Resolve one model-supplied path.
   * @param {string} filePath
   * @returns {Promise<any>}
   */
  async target(filePath) {
    return this.fs.resolve(filePath, { cwd: await this.cwd(), signal: this.signal });
  }

  /**
   * Resolve the translations directory.
   * @param {string|undefined} directory
   * @returns {Promise<{target: any, path: string, displayPath: string}>}
   */
  async resolveDirectory(directory) {
    const raw = directory ?? this.config.translationsDir;
    const target = await this.target(raw);
    const info = await this.fs.stat(target, this.signal);
    if (info === undefined) {
      throw new ProjectError(
        `translations directory not found: ${target.displayPath}. Pass dir with the directory that contains the .ts files.`,
      );
    }
    if (info.type !== 'directory') {
      throw new ProjectError(`not a directory: ${target.displayPath}. Pass dir with the directory that contains the .ts files.`);
    }
    return {
      target,
      path: this.fs.processPath(target),
      displayPath: displayPath(this.fs.processPath(target), await this.cwd()),
    };
  }

  /**
   * List the `.ts` files of a translations directory.
   * @param {string|undefined} directory
   * @returns {Promise<Array<DiscoveredFile>>}
   */
  async discover(directory) {
    const resolved = await this.resolveDirectory(directory);
    const entries = await this.fs.listDir(resolved.target, this.signal);
    const files = [];
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.ts')) continue;
      const absolute = this.fs.processPath(entry.target);
      let language = null;
      try {
        const header = await this.fs.readByteRange(entry.target, { offset: 0, length: HEADER_BYTES }, this.signal);
        const match = LANGUAGE_ATTRIBUTE.exec(decodeHeader(header));
        if (match !== null) language = match[1];
      } catch {
        // Fall back to the lupdate naming convention below.
      }
      files.push({
        path: absolute,
        displayPath: displayPath(absolute, await this.cwd()),
        language: language ?? languageFromFileName(absolute),
        target: entry.target,
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    if (files.length === 0) {
      throw new ProjectError(`no .ts files in ${resolved.displayPath}`);
    }
    return files;
  }

  /**
   * Resolve a language spec into discovered files.
   * @param {string} spec
   * @param {string|undefined} directory
   * @returns {Promise<Array<DiscoveredFile>>}
   */
  async resolveFiles(spec, directory) {
    if (spec.toLowerCase().endsWith('.ts')) {
      const files = [];
      for (const item of spec.split(',').map((part) => part.trim()).filter(Boolean)) {
        const target = await this.target(item);
        const info = await this.fs.stat(target, this.signal);
        if (info === undefined || info.type !== 'file') throw new ProjectError(`no such file: ${item}`);
        const absolute = this.fs.processPath(target);
        let language = languageFromFileName(absolute);
        try {
          const header = await this.fs.readByteRange(target, { offset: 0, length: HEADER_BYTES }, this.signal);
          const match = LANGUAGE_ATTRIBUTE.exec(decodeHeader(header));
          if (match !== null) language = match[1];
        } catch {
          // Keep the file-name fallback.
        }
        files.push({
          path: absolute,
          displayPath: displayPath(absolute, await this.cwd()),
          language,
          target,
        });
      }
      return files;
    }
    const available = await this.discover(directory);
    return resolveLanguageFiles(spec, available);
  }

  /**
   * Load one discovered file.
   * @param {DiscoveredFile} file
   * @returns {Promise<LoadedLanguage>}
   */
  async loadFile(file) {
    const info = await this.fs.stat(file.target, this.signal);
    if (info === undefined) throw new ProjectError(`file disappeared: ${file.displayPath}`);
    let bytes;
    try {
      bytes = await this.fs.readBytes(file.target, this.signal, this.config.maxFileBytes);
    } catch (error) {
      throw new ProjectError(
        `cannot read ${file.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const document = parseBytes(bytes, file.path);
    document.path = file.path;
    document.target = file.target;
    document.displayPath = file.displayPath;
    this.ctx.emit('fs/observed', file.target, { kind: 'present', version: info.version }, this.exec);

    const byId = new Map();
    const byKey = new Map();
    for (const context of document.contexts) {
      for (const message of context.messages) {
        const list = byId.get(message.shortId);
        if (list === undefined) byId.set(message.shortId, [message]);
        else list.push(message);
        const key = `${message.context}\0${message.source}\0${message.comment}`;
        if (!byKey.has(key)) byKey.set(key, message);
      }
    }
    const sourceLanguage = document.sourceLanguage || DEFAULT_SOURCE_LANGUAGE;
    return {
      file,
      document,
      byId,
      byKey,
      isSourceLanguage: baseLanguage(file.language) === baseLanguage(sourceLanguage),
    };
  }

  /**
   * Load every selected language, reporting per-file failures instead of
   * aborting the whole call.
   * @param {string} spec
   * @param {string|undefined} directory
   * @returns {Promise<{loaded: LoadedLanguage[], errors: Array<{file: DiscoveredFile, error: string}>, directory: string}>}
   */
  async loadAll(spec, directory) {
    const files = await this.resolveFiles(spec, directory);
    const loaded = [];
    const errors = [];
    for (const file of files) {
      try {
        loaded.push(await this.loadFile(file));
      } catch (error) {
        const message = error instanceof TsParseError || error instanceof ProjectError || error instanceof Error
          ? error.message
          : String(error);
        errors.push({
          file,
          error: message,
          kind: error instanceof TsParseError ? error.kind : 'unreadable',
          line: error instanceof TsParseError ? error.line : null,
        });
      }
    }
    const resolved = await this.resolveDirectory(directory);
    return { loaded, errors, directory: resolved.displayPath };
  }

  /**
   * Load the glossary next to the translation files, if configured and present.
   * @param {string|undefined} directory
   * @returns {Promise<{glossary: import('./glossary.js').Glossary, error: string|null, path: string|null}>}
   */
  async loadGlossary(directory) {
    const name = this.config.glossaryFile;
    if (!name) return { glossary: null, error: null, path: null };
    const resolved = await this.resolveDirectory(directory);
    const absolute = path.resolve(resolved.path, name);
    const target = await this.target(absolute);
    const info = await this.fs.stat(target, this.signal);
    if (info === undefined) return { glossary: null, error: null, path: null };
    try {
      const text = await this.fs.readText(target, this.signal);
      return { glossary: parseGlossary(text, absolute), error: null, path: absolute };
    } catch (error) {
      return {
        glossary: null,
        error: error instanceof Error ? error.message : String(error),
        path: absolute,
      };
    }
  }

  /**
   * Write one document atomically, honoring the observation and sandbox policy.
   * @param {import('./model.js').TsDocument} document
   * @returns {Promise<{operation: string, version: any}>}
   */
  async save(document) {
    const content = writeText(document);
    const target = document.target;
    if (target === null || target === undefined) throw new Error('document has no filesystem target');
    const info = await this.fs.stat(target, this.signal);
    if (info === undefined) throw new ProjectError(`file disappeared: ${document.path}`);
    this.ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, this.exec);
    const intent = await this.ctx.waterfall('fs/write-intent', target, this.exec, () => undefined);
    const outcome = await this.fs.writeText(target, content, intent, this.signal, this.policy());
    this.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, this.exec);
    return outcome;
  }

  /**
   * Read a UTF-8 file for a bounded code excerpt.
   * @param {string} absolutePath
   * @param {number} radius
   * @param {number} lineNumber
   * @returns {Promise<{lines: string[], total: number}>}
   */
  async readCodeWindow(absolutePath, lineNumber, radius) {
    const target = await this.target(absolutePath);
    const info = await this.fs.stat(target, this.signal);
    if (info === undefined || info.type !== 'file') throw new ProjectError('file not found');
    const text = await this.fs.readText(target, this.signal);
    const lines = text.split(/\r?\n/u);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const first = Math.max(1, lineNumber - radius);
    const last = Math.min(lines.length, lineNumber + radius);
    const width = String(last).length;
    const window = [];
    for (let number = first; number <= last; number += 1) {
      const marker = number === lineNumber ? '>' : ' ';
      window.push(`${marker}${String(number).padStart(width, ' ')}| ${lines[number - 1]}`);
    }
    return { lines: window, total: lines.length };
  }
}
