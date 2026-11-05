/**
 * The `qt_ts_*` agent tools.
 *
 * Every read and write goes through the Runtime, which uses `ctx.fs`, so the
 * session sandbox and the read-before-write observation policy apply. Writes
 * are all-or-nothing: a rejected entry never reaches disk.
 */

import path from 'node:path';

import { Runtime } from '../lib/context.js';
import { Finding, RULES, Severity, runChecks, parseSeverity, severityLabel } from '../lib/checks.js';
import { applyEntries, countResults, parseEntry, parseEntryText, pruneDocument, resultRecord } from '../lib/editing.js';
import { termRecord } from '../lib/glossary.js';
import { DEFAULT_MINIMUM_RATIO, DEFAULT_SUGGESTION_LIMIT, suggest } from '../lib/memory.js';
import { baseLanguage, displayPath } from '../lib/project.js';
import {
  MessageFilter,
  codeExcerpts,
  compileFilter,
  contextStatsRecords,
  listRecord,
  missingActiveCounts,
  parseStates,
  resolveIds,
  showRecord,
  statsRecord,
  translationValue,
} from '../lib/query.js';
import {
  renderApplyRecord,
  renderContextStats,
  renderFinding,
  renderListRecord,
  renderPruneRecord,
  renderRule,
  renderShowRecord,
  renderStats,
  renderSuggestions,
  renderTerm,
  renderValue,
} from '../lib/render.js';

/**
 * @param {unknown} value
 * @returns {Array<{type: 'text', text: string}>}
 */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : renderValue(value) }];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function splitList(value) {
  return asArray(value)
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {Runtime} runtime
 * @returns {Promise<{root: string, buildDirectories: readonly string[]}>}
 */
async function layoutOf(runtime) {
  return { root: await runtime.cwd(), buildDirectories: runtime.config.buildDirectories };
}

/**
 * @param {Runtime} runtime
 * @param {string} lang
 * @param {string|undefined} directory
 * @returns {Promise<import('../lib/context.js').LoadedLanguage>}
 */
async function loadSingle(runtime, lang, directory) {
  const { loaded, errors } = await runtime.loadAll(lang, directory);
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.error).join('; '));
  if (loaded.length !== 1) throw new Error('this tool works on exactly one language; use --lang with a single language');
  return loaded[0];
}

/**
 * @param {import('../lib/glossary.js').Glossary|null} glossary
 * @param {object} record
 */
function attachGlossaryHints(glossary, record) {
  if (glossary === null) return;
  const terms = glossary.find(record.source, record.context);
  if (terms.length > 0) record.glossary = terms.map((term) => term.brief());
}

/**
 * @param {Runtime} runtime
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
async function findTsCandidates(runtime, rootDir) {
  const skip = new Set(['node_modules', '.git', '.cache', ...runtime.config.buildDirectories]);
  const results = [];
  const queue = [{ target: await runtime.target(rootDir), depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && results.length < 20 && visited < 500) {
    const current = queue.shift();
    visited += 1;
    let entries;
    try {
      entries = await runtime.fs.listDir(current.target, runtime.signal);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.type === 'directory' && current.depth < 4 && !skip.has(entry.name)) {
        queue.push({ target: entry.target, depth: current.depth + 1 });
      } else if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.ts')) {
        results.push(displayPath(runtime.fs.processPath(entry.target), (await runtime.cwd()) || rootDir));
      }
    }
  }
  return results;
}

/**
 * @param {ReturnType<import('../lib/config.js').resolveConfig>} config
 * @returns {object}
 */
function dirParameter(config) {
  return {
    type: 'string',
    description: `Directory containing the .ts files. Defaults to "${config.translationsDir}" relative to the session directory.`,
  };
}

const LANG_PARAMETER = {
  type: 'string',
  description: 'Language: "ru", "ru_RU", "zh", a comma list, "all", or a path to a .ts file.',
};

/**
 * Register every linguist tool.
 * @param {any} ctx
 * @param {ReturnType<import('../lib/config.js').resolveConfig>} config
 */
export function registerTools(ctx, config) {
  // --- status ---------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_status',
    description:
      'Overview of Qt Linguist .ts translation files: message counts per state, missing messages compared with other languages, format drift, and files that cannot be written back safely. Start here before translating or reviewing. If the translations directory is not found, the result lists candidate .ts files in the session directory.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        lang: { ...LANG_PARAMETER, description: 'Languages to report: default "all".' },
        by_context: { type: 'boolean', description: 'Also report counts for every context.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const parts = (value.files ?? []).map(renderStats);
        if (value.contexts?.length) parts.push(value.contexts.map(renderContextStats).join('\n'));
        if (value.glossary) parts.push(`glossary: ${value.glossary.terms} term(s) in ${value.glossary.file}`);
        if (value.glossary_error) parts.push(`glossary error: ${value.glossary_error}`);
        const body = parts.join('\n\n');
        if (body) return text(body);
        const candidates = value.candidates?.length
          ? `\n\ncandidates:\n${value.candidates.map((item) => `  ${item}`).join('\n')}`
          : '';
        return text(`${value.error ?? 'no translation files found'}${candidates}`);
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const runtime = new Runtime({ ctx, config, exec });
      const lang = typeof args.lang === 'string' && args.lang.trim() ? args.lang : 'all';
      let loaded;
      let errors;
      let directory;
      try {
        const all = await runtime.loadAll(lang, args.dir);
        loaded = all.loaded;
        errors = all.errors;
        directory = all.directory;
      } catch (error) {
        const candidates = await findTsCandidates(runtime, args.dir ?? config.translationsDir).catch(() => []);
        return { found: false, error: error instanceof Error ? error.message : String(error), candidates };
      }
      const missing = loaded.length > 1 ? missingActiveCounts(loaded) : new Map();
      const files = loaded.map((language) => statsRecord(language, missing.get(language.file.language) ?? null));
      for (const failure of errors) {
        files.push({
          lang: failure.file.language,
          file: failure.file.displayPath,
          error: failure.error,
          write_blockers: [failure.error],
        });
      }
      const glossaryInfo = await runtime.loadGlossary(args.dir).catch((error) => ({ glossary: null, error: String(error), path: null }));
      const result = {
        found: true,
        directory,
        files,
        glossary: glossaryInfo.glossary
          ? { file: path.basename(glossaryInfo.path ?? 'glossary.json'), terms: glossaryInfo.glossary.terms.length }
          : null,
        glossary_error: glossaryInfo.error,
      };
      if (args.by_context) {
        result.contexts = loaded.flatMap((language) => contextStatsRecords(language));
      }
      return result;
    },
    presentCall: (args) => ({ card: 'generic', title: `Qt translations status${args.lang ? `: ${args.lang}` : ''}`, kind: 'read' }),
  });

  // --- find -----------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_find',
    description:
      'Find messages of one language file by state, context, source/translation text, location, or id prefix. Returns the message id, context, source, translation, state, note, and optionally other languages side by side. States: translated, draft (unfinished with text), untranslated (unfinished, empty), blank (finished, empty: a bug), vanished. Default state is every active state.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        lang: { ...LANG_PARAMETER, description: 'The language to list; exactly one.' },
        state: {
          type: 'string',
          description: 'Comma list of states, plus "active" (default) and "all".',
        },
        context: { type: 'string', description: 'Regex over the context name.' },
        source: { type: 'string', description: 'Regex over the source text.' },
        translation: { type: 'string', description: 'Regex over the translation text.' },
        location: { type: 'string', description: 'Regex over location file names.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids or id prefixes (at least 4 characters).',
        },
        literal: { type: 'boolean', description: 'Treat the pattern arguments as plain substrings.' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive matching.' },
        with_langs: {
          ...LANG_PARAMETER,
          description: 'Other languages to show side by side, e.g. "en,zh".',
        },
        locations: { type: 'boolean', description: 'Include source locations.' },
        glossary: { type: 'boolean', description: 'Include glossary terms found in each source.' },
        limit: { type: 'integer', description: `Page size; defaults to ${config.defaultLimit}, 0 = no limit.` },
        offset: { type: 'integer', description: 'Skip this many matches.' },
        count: { type: 'boolean', description: 'Only return the number of matches.' },
      },
      required: ['lang'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          value.count !== undefined
            ? `${value.lang}: ${value.count} matches`
            : (value.records ?? []).map(renderListRecord).join('\n\n') ||
                `no matches (${value.total ?? 0} total)`,
        ),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const runtime = new Runtime({ ctx, config, exec });
      const lang = String(args.lang ?? '');
      if (!lang) throw new Error('lang is required');
      const primary = await loadSingle(runtime, lang, args.dir);
      const others = args.with_langs
        ? (await runtime.loadAll(String(args.with_langs), args.dir)).loaded.filter(
            (language) => language.file.path !== primary.file.path,
          )
        : [];

      const ids = splitList(args.ids).map((id) => id.toLowerCase());
      const filter = new MessageFilter({
        states: parseStates(args.state),
        context: compileFilter(args.context, Boolean(args.literal), Boolean(args.case_sensitive)),
        source: compileFilter(args.source, Boolean(args.literal), Boolean(args.case_sensitive)),
        translation: compileFilter(args.translation, Boolean(args.literal), Boolean(args.case_sensitive)),
        location: compileFilter(args.location, Boolean(args.literal), Boolean(args.case_sensitive)),
        ids,
      });
      const matched = [];
      for (const context of primary.document.contexts) {
        for (const message of context.messages) if (filter.matches(message)) matched.push(message);
      }
      if (args.count) return { lang: primary.file.language, count: matched.length };

      const glossaryInfo = args.glossary ? await runtime.loadGlossary(args.dir) : { glossary: null };
      const layout = await layoutOf(runtime);
      const limit = args.limit === undefined ? config.defaultLimit : Number(args.limit);
      const offset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be a non-negative integer');
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
      if (limit > config.maxLimit) throw new Error(`limit must be at most ${config.maxLimit}`);
      const end = limit === 0 ? matched.length : offset + limit;
      const page = matched.slice(offset, end);
      const records = page.map((message) => {
        const record = listRecord(message, primary, others, Boolean(args.locations), layout);
        attachGlossaryHints(glossaryInfo.glossary ?? null, record);
        return record;
      });
      return {
        lang: primary.file.language,
        total: matched.length,
        shown: records.length,
        next_offset: offset + records.length < matched.length ? offset + records.length : null,
        records,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Find ${args.lang ?? ''} messages${args.state ? ` (${args.state})` : ''}`, kind: 'read' }),
  });

  // --- show -----------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_show',
    description:
      'Show one message in every language file with its source locations, optional code excerpts around each location, and glossary terms found in its source. Accepts a unique id prefix of at least 4 characters. Use it to disambiguate the meaning of a string before translating it.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids or unique id prefixes (at least 4 characters).',
        },
        lang: { ...LANG_PARAMETER, description: 'Languages to show; default "all".' },
        code: {
          type: 'integer',
          description: `Lines of source code around each location; defaults to ${config.codeContextRadius}, 0 disables excerpts.`,
        },
      },
      required: ['ids'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text((value.records ?? []).map(renderShowRecord).join('\n\n')),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const runtime = new Runtime({ ctx, config, exec });
      const specs = splitList(args.ids);
      if (specs.length === 0) throw new Error('ids is required');
      const { loaded, errors } = await runtime.loadAll(typeof args.lang === 'string' && args.lang ? args.lang : 'all', args.dir);
      if (errors.length > 0) throw new Error(errors.map((entry) => entry.error).join('; '));
      const glossaryInfo = await runtime.loadGlossary(args.dir);
      const layout = await layoutOf(runtime);
      const radius = args.code === undefined ? config.codeContextRadius : Number(args.code);
      if (!Number.isInteger(radius) || radius < 0) throw new Error('code must be a non-negative integer');

      const records = [];
      for (const [spec, shortIds] of resolveIds(specs, loaded)) {
        if (shortIds.length !== 1) {
          let error;
          if (shortIds.length > 1) error = `ambiguous prefix: ${shortIds.join(', ')}`;
          else if (spec.length < 4) error = 'not found (id prefixes need at least 4 characters)';
          else error = 'not found';
          records.push({ id: spec, error });
          continue;
        }
        const record = showRecord(shortIds[0], loaded, radius, layout);
        attachGlossaryHints(glossaryInfo.glossary ?? null, record);
        if (radius > 0) {
          const present = loaded
            .map((language) => [language, language.byId.get(shortIds[0]) ?? []])
            .filter(([, messages]) => messages.length > 0);
          present.sort((left, right) => right[1][0].locations.length - left[1][0].locations.length);
          record.code = await codeExcerpts(runtime, present[0][0].file.path, present[0][1], radius, layout);
        }
        records.push(record);
      }
      return { records };
    },
    presentCall: (args) => ({ card: 'generic', title: `Show message ${splitList(args.ids).join(', ')}`, kind: 'read' }),
  });

  // --- lint -----------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_lint',
    description:
      'Lint .ts files: placeholders, plural forms, empty finished translations, mnemonics, markup, scripts, duplicates, desync between languages, vanished messages, and optional glossary violations. Exit severity is informational; findings are sorted by severity. Set list_rules to print the rule catalog.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        lang: { ...LANG_PARAMETER, description: 'Languages to check; default "all".' },
        rule: { type: 'string', description: 'Comma-separated rules to run; default all.' },
        severity: { type: 'string', enum: ['error', 'warning', 'info'], description: 'Minimum severity to return; default warning.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Only findings about these ids or id prefixes.' },
        limit: { type: 'integer', description: 'Page size; default 100, 0 = no limit.' },
        offset: { type: 'integer', description: 'Skip this many findings.' },
        list_rules: { type: 'boolean', description: 'Print the rule catalog instead of checking.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.rules) return text(value.rules.map(renderRule).join('\n'));
        const body = (value.findings ?? []).map(renderFinding).join('\n');
        return text(`${body}${body ? '\n\n' : ''}${value.summary.error} error(s), ${value.summary.warning} warning(s), ${value.summary.info} info; showing ${value.summary.shown} of ${value.summary.total}`);
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.list_rules) {
        return {
          rules: Object.entries(RULES).map(([rule, [severity, description]]) => ({
            rule,
            severity: severityLabel(severity),
            description,
          })),
        };
      }
      const runtime = new Runtime({ ctx, config, exec });
      const lang = typeof args.lang === 'string' && args.lang ? args.lang : 'all';
      const { loaded, errors } = await runtime.loadAll(lang, args.dir);
      const glossaryInfo = await runtime.loadGlossary(args.dir);
      const layout = await layoutOf(runtime);
      const findings = runChecks(loaded, {
        glossary: glossaryInfo.glossary,
        glossaryError: glossaryInfo.error,
        root: layout.root,
        buildDirectories: layout.buildDirectories,
      });
      for (const failure of errors) {
        const rule = failure.kind === 'merge-conflict' ? 'merge-conflict' : 'unreadable';
        findings.push(new Finding(rule, failure.error, failure.file.language, null));
      }
      let rules = new Set(Object.keys(RULES));
      if (args.rule) {
        rules = new Set(splitList(args.rule));
        const unknown = [...rules].filter((rule) => !Object.hasOwn(RULES, rule));
        if (unknown.length > 0) throw new Error(`unknown rule(s): ${unknown.join(', ')}; call with list_rules=true`);
      }
      const minimum = parseSeverity(typeof args.severity === 'string' ? args.severity : 'warning');
      const ids = splitList(args.ids).map((id) => id.toLowerCase());
      const filtered = findings.filter(
        (finding) =>
          rules.has(finding.rule) &&
          finding.severity >= minimum &&
          (ids.length === 0 || (finding.message !== null && ids.some((prefix) => finding.message.shortId.startsWith(prefix)))),
      );
      const counts = { error: 0, warning: 0, info: 0 };
      for (const finding of findings) {
        if (finding.severity === Severity.ERROR) counts.error += 1;
        else if (finding.severity === Severity.WARNING) counts.warning += 1;
        else counts.info += 1;
      }
      filtered.sort((left, right) => right.severity - left.severity);
      const limit = args.limit === undefined ? 100 : Number(args.limit);
      const offset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be a non-negative integer');
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
      const end = limit === 0 ? filtered.length : offset + limit;
      const page = filtered.slice(offset, end);
      const byRule = {};
      for (const finding of filtered) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
      return {
        findings: page.map((finding) => finding.toRecord()),
        summary: {
          ...counts,
          by_rule: byRule,
          total: filtered.length,
          shown: page.length,
          next_offset: offset + page.length < filtered.length ? offset + page.length : null,
          has_errors: counts.error > 0,
        },
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Lint Qt translations${args.lang ? `: ${args.lang}` : ''}`, kind: 'search' }),
  });

  // --- apply ----------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_apply',
    description:
      'Write translation entries to one language file. All-or-nothing: every entry is validated first, and the file is written once only when no entry is rejected. Identify a message by full 8-character id or by context + source (+ comment). Fields: translation (string, or array of forms for a plural message), state ("finished" or "unfinished"), note (translator comment). A translation without state becomes finished; an empty translation becomes unfinished. Set dry_run to validate without writing.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        lang: { ...LANG_PARAMETER, description: 'The one language file to change.' },
        entries: {
          oneOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Full 8-character message id.' },
                  context: { type: 'string', description: 'Message context, with source, when id is omitted.' },
                  source: { type: 'string', description: 'Source text, with context, when id is omitted.' },
                  comment: { type: 'string', description: 'Disambiguation comment that is part of the message key.' },
                  translation: {
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    description: 'Translation, or the list of forms for a plural message.',
                  },
                  state: { type: 'string', enum: ['finished', 'unfinished'], description: 'Write state; omitted keeps it.' },
                  note: { type: 'string', description: 'Translator comment shown in Qt Linguist; "" clears it.' },
                },
              },
            },
            { type: 'string', description: 'JSON array or JSON Lines with the same entries.' },
          ],
          description: 'Entries to apply.',
        },
        dry_run: { type: 'boolean', description: 'Validate and report without writing.' },
        force: { type: 'boolean', description: 'Write entries even when validation reports an error-level issue.' },
      },
      required: ['lang', 'entries'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const body = (value.results ?? []).map(renderApplyRecord).join('\n');
        const summary = value.summary ?? {};
        const state = summary.written
          ? 'written'
          : summary.blocked
            ? 'batch blocked, nothing written'
            : summary.dry_run
              ? 'dry run, not written'
              : 'not written';
        return text(
          `${body}${body ? '\n\n' : ''}${value.lang}: ${summary.updated ?? 0} updated, ${summary.unchanged ?? 0} unchanged, ${summary.rejected ?? 0} rejected, ${summary.not_found ?? 0} not found; ${state}${summary.format_drift_normalized ? ' (formatting normalized)' : ''}`,
        );
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!config.allowWrites && !args.dry_run) {
        throw new Error('writes are disabled by the linguist-tools allowWrites config; set dry_run=true to validate');
      }
      const runtime = new Runtime({ ctx, config, exec });
      const lang = String(args.lang ?? '');
      if (!lang) throw new Error('lang is required');
      const language = await loadSingle(runtime, lang, args.dir);
      if (language.document.writeBlockers.length > 0 && !args.dry_run) {
        throw new Error(`${language.file.language} cannot be written: ${language.document.writeBlockers.join('; ')}`);
      }
      let entries;
      if (typeof args.entries === 'string') entries = parseEntryText(args.entries);
      else if (Array.isArray(args.entries)) entries = args.entries.map((entry, index) => ({ line: index + 1, ...parseEntry(entry) }));
      else throw new Error('entries must be an array or a JSON/JSONL string');
      if (entries.length === 0) throw new Error('no entries in the input');

      const glossaryInfo = await runtime.loadGlossary(args.dir);
      if (glossaryInfo.error) throw new Error(`glossary is invalid: ${glossaryInfo.error}`);
      const driftBefore = language.document.formatDrift;
      const results = applyEntries(language, entries, { force: Boolean(args.force), glossary: glossaryInfo.glossary });
      const counts = countResults(results);
      const blocked = counts.rejected > 0 || counts.not_found > 0;
      const written = counts.updated > 0 && blocked === false && !args.dry_run;
      if (written) await runtime.save(language.document);
      return {
        lang: language.file.language,
        results: results.map(resultRecord),
        summary: {
          ...counts,
          blocked,
          dry_run: Boolean(args.dry_run),
          written,
          format_drift_normalized: written && driftBefore !== null,
        },
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Apply ${Array.isArray(args.entries) ? args.entries.length : 0} translation(s) to ${args.lang}`, kind: 'edit' }),
  });

  // --- prune ----------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_prune',
    description:
      'Remove vanished/obsolete messages and contexts left without messages. Deletion is destructive, so dry_run defaults to true: call once to preview, then with dry_run=false to write. Ask the user before writing when unsure.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        lang: { ...LANG_PARAMETER, description: 'Languages to prune; default "all".' },
        dry_run: { type: 'boolean', description: 'Preview without writing; defaults to true.' },
        list: { type: 'boolean', description: 'List every removed message.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [];
        for (const file of value.files ?? []) lines.push(renderPruneRecord(file));
        for (const file of value.files ?? []) {
          for (const message of file.messages ?? []) lines.push(renderPruneRecord({ ...message, lang: file.lang }));
        }
        lines.push(`removed ${value.summary?.removed_messages ?? 0} messages (${value.summary?.dry_run ? 'dry run' : 'written'})`);
        return text(lines.join('\n'));
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const dryRun = args.dry_run !== false;
      if (!config.allowWrites && !dryRun) throw new Error('writes are disabled by the linguist-tools allowWrites config');
      const runtime = new Runtime({ ctx, config, exec });
      const lang = typeof args.lang === 'string' && args.lang ? args.lang : 'all';
      const { loaded, errors } = await runtime.loadAll(lang, args.dir);
      const files = [];
      let total = 0;
      for (const language of loaded) {
        if (language.document.writeBlockers.length > 0 && !dryRun) {
          files.push({
            lang: language.file.language,
            removed_messages: 0,
            removed_contexts: [],
            written: false,
            error: `cannot write: ${language.document.writeBlockers.join('; ')}`,
          });
          continue;
        }
        const before = language.document.formatDrift;
        const pruned = pruneDocument(language.document);
        total += pruned.messages.length;
        const removed = pruned.messages.length > 0 || pruned.contexts.length > 0;
        const written = removed && !dryRun;
        if (written) await runtime.save(language.document);
        const record = {
          lang: language.file.language,
          removed_messages: pruned.messages.length,
          removed_contexts: pruned.contexts.map((context) => context.name),
          written,
          format_drift_normalized: written && before !== null,
        };
        if (args.list) {
          record.messages = pruned.messages.map((message) => ({
            id: message.shortId,
            context: message.context,
            source: message.source,
            translation: translationValue(message),
          }));
        }
        files.push(record);
      }
      for (const failure of errors) {
        files.push({
          lang: failure.file.language,
          removed_messages: 0,
          removed_contexts: [],
          written: false,
          error: failure.error,
        });
      }
      return { files, summary: { removed_messages: total, dry_run: dryRun } };
    },
    presentCall: (args) => ({ card: 'generic', title: `Prune ${args.lang ?? 'all'} translations${args.dry_run === false ? '' : ' (dry run)'}`, kind: 'delete' }),
  });

  // --- memory ---------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_memory',
    description:
      'Translation memory: find existing translations of identical or similar source texts. Pass message ids (useful before translating them) and/or free text. Use it to keep terminology and phrasing consistent with translations already in the file.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        lang: { ...LANG_PARAMETER, description: 'The language whose translations to search; exactly one.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids or unique id prefixes to look up.' },
        text: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Free source text to look up.',
        },
        min_ratio: { type: 'number', description: `Similarity cut-off in (0, 1]; default ${DEFAULT_MINIMUM_RATIO}.` },
        limit: { type: 'integer', description: `Matches per query; default ${DEFAULT_SUGGESTION_LIMIT}.` },
      },
      required: ['lang'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text((value.queries ?? []).map(renderSuggestions).join('\n\n')),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const runtime = new Runtime({ ctx, config, exec });
      const lang = String(args.lang ?? '');
      if (!lang) throw new Error('lang is required');
      const language = await loadSingle(runtime, lang, args.dir);
      const specs = splitList(args.ids);
      const texts = asArray(args.text);
      if (specs.length === 0 && texts.length === 0) throw new Error('give message ids and/or text');
      const minimum = args.min_ratio === undefined ? DEFAULT_MINIMUM_RATIO : Number(args.min_ratio);
      if (!(minimum > 0 && minimum <= 1)) throw new Error('min_ratio must be in (0, 1]');
      const limit = args.limit === undefined ? DEFAULT_SUGGESTION_LIMIT : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');

      const everyLanguage = specs.length > 0 ? (await runtime.loadAll('all', args.dir)).loaded : [];
      const allLanguages = [language, ...everyLanguage.filter((candidate) => candidate.file.path !== language.file.path)];
      const queries = [];
      for (const [spec, shortIds] of resolveIds(specs, allLanguages)) {
        if (shortIds.length !== 1) {
          queries.push({ query: { id: spec }, error: 'not found or ambiguous', matches: [] });
          continue;
        }
        let message;
        for (const candidate of allLanguages) {
          const found = candidate.byId.get(shortIds[0]);
          if (found !== undefined && found.length > 0) {
            message = found[0];
            break;
          }
        }
        if (message === undefined) {
          queries.push({ query: { id: spec }, error: 'not found or ambiguous', matches: [] });
          continue;
        }
        const excludeKey = `${message.context}\0${message.source}\0${message.comment}`;
        queries.push({
          query: { id: message.shortId, context: message.context, source: message.source },
          matches: suggest(message.source, language, { excludeKey, minimum, limit }),
        });
      }
      for (const source of texts) {
        queries.push({ query: { source }, matches: suggest(source, language, { minimum, limit }) });
      }
      return { lang: language.file.language, queries };
    },
    presentCall: (args) => ({ card: 'generic', title: `Translation memory: ${args.lang}`, kind: 'read' }),
  });

  // --- glossary -------------------------------------------------------------------------------------------------------

  ctx.tools.register({
    name: 'qt_ts_glossary',
    description:
      'Look up the terminology glossary (glossary.json next to the .ts files), or list and filter its terms. A term has per-language renderings, optional variants, avoid (wrong renderings), context scope, and exceptions by message id. Use it before choosing a translation for a technical term. Writing new terms is a normal file edit of glossary.json.',
    parameters: {
      type: 'object',
      properties: {
        dir: dirParameter(config),
        ids: { type: 'array', items: { type: 'string' }, description: 'Message ids or prefixes whose sources to look up.' },
        text: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Free source text to look up.',
        },
        context: { type: 'string', description: 'Context used for text lookups; selects context-scoped terms.' },
        lang: { type: 'string', description: 'Languages to show: "ru", "zh", "ru,zh", or "all" (default).' },
        term: { type: 'string', description: 'Regex over term names.' },
        status: { type: 'string', enum: ['approved', 'proposed'], description: 'Only terms with this status.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.terms) return text(`${value.terms.map((term) => renderTerm(term)).join('\n\n')}${value.terms.length ? `\n\n${value.terms.length} term(s)` : 'no terms'}`);
        return text((value.queries ?? []).map((query) => renderTerm(query)).join('\n\n'));
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const runtime = new Runtime({ ctx, config, exec });
      const glossaryInfo = await runtime.loadGlossary(args.dir);
      if (glossaryInfo.error) throw new Error(glossaryInfo.error);
      const glossary = glossaryInfo.glossary;
      if (glossary === null) throw new Error(`no glossary found next to the translations (${config.glossaryFile})`);

      const languages =
        typeof args.lang === 'string' && args.lang && args.lang.toLowerCase() !== 'all'
          ? new Set(splitList(args.lang).map((item) => baseLanguage(item)))
          : null;
      const termPattern = args.term === undefined ? null : compileFilter(args.term, false, false);
      const terms = glossary.terms.filter(
        (term) =>
          (termPattern === null || termPattern.test(term.term)) &&
          (args.status === undefined || term.status === args.status),
      );
      const specs = splitList(args.ids);
      const texts = asArray(args.text);

      if (specs.length === 0 && texts.length === 0) {
        return {
          file: glossaryInfo.path,
          terms: terms.map((term) => termRecord(term, languages)),
        };
      }

      const queries = [];
      if (specs.length > 0) {
        const { loaded } = await runtime.loadAll('all', args.dir);
        for (const [spec, shortIds] of resolveIds(specs, loaded)) {
          if (shortIds.length !== 1) {
            queries.push({ query: { id: spec }, error: 'not found or ambiguous', terms: [] });
            continue;
          }
          let message;
          for (const language of loaded) {
            const found = language.byId.get(shortIds[0]);
            if (found !== undefined && found.length > 0) {
              message = found[0];
              break;
            }
          }
          if (message === undefined) {
            queries.push({ query: { id: spec }, error: 'not found or ambiguous', terms: [] });
            continue;
          }
          queries.push({
            query: { id: message.shortId, context: message.context, source: message.source },
            terms: glossary
              .find(message.source, message.context)
              .filter((term) => terms.includes(term))
              .map((term) => termRecord(term, languages)),
          });
        }
      }
      for (const source of texts) {
        queries.push({
          query: { source, context: args.context ?? '' },
          terms: glossary
            .find(source, args.context ?? '')
            .filter((term) => terms.includes(term))
            .map((term) => termRecord(term, languages)),
        });
      }
      return { file: glossaryInfo.path, queries };
    },
    presentCall: (args) => ({ card: 'generic', title: 'Qt translation glossary', kind: 'search' }),
  });
}
