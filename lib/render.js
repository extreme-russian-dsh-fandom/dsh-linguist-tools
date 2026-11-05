/**
 * Human-readable renderers for tool results. The structured value stays
 * available to the tool runtime; the model reads these text blocks.
 */

import { ALL_STATES } from './model.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function quote(value) {
  return JSON.stringify(value);
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderStats(record) {
  const cells = [`${String(record.lang).padEnd(8)}`];
  for (const key of ['messages', ...ALL_STATES, 'missing_active']) {
    if (record[key] !== undefined && record[key] !== null) cells.push(`${key}=${record[key]}`);
  }
  const lines = [cells.join('  ')];
  if (record.file) lines.push(`    file: ${record.file}`);
  if (record.format_drift) lines.push(`    format drift: ${record.format_drift}`);
  for (const blocker of record.write_blockers ?? []) lines.push(`    write blocked: ${blocker}`);
  return lines.join('\n');
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderContextStats(record) {
  const counts = ALL_STATES.filter((state) => record[state]).map((state) => `${state}=${record[state]}`);
  return `${String(record.lang).padEnd(8)} ${String(record.context).padEnd(48)} ${counts.join('  ')}`;
}

/**
 * @param {object} hint
 * @param {string} indent
 * @returns {string[]}
 */
function glossaryHintLines(hint, indent) {
  const proposed = hint.proposed ?? [];
  const renderings = Object.entries(hint)
    .filter(([key]) => key !== 'term' && key !== 'proposed')
    .map(([key, value]) => `${key}: ${quote(value)}${proposed.includes(key) ? ' (proposed)' : ''}`);
  return [`${indent}term ${quote(hint.term)}: ${renderings.join(', ')}`];
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderListRecord(record) {
  const header = `${record.id} ${String(record.state).padEnd(12)} ${record.context} | ${quote(record.source)}`;
  const lines = [`${header} => ${quote(record.translation)}`];
  for (const key of ['comment', 'extra', 'note']) {
    if (record[key] !== undefined) lines.push(`    ${key}: ${quote(record[key])}`);
  }
  for (const [language, entry] of Object.entries(record.others ?? {})) {
    const shown = entry === null ? '<absent>' : `${quote(entry.translation)} (${entry.state})`;
    lines.push(`    ${language}: ${shown}`);
  }
  if (record.locations !== undefined) lines.push(`    at: ${(record.locations ?? []).join(', ') || '<none>'}`);
  if (record.build_locations) lines.push(`    (+${record.build_locations} build-tree locations)`);
  for (const hint of record.glossary ?? []) lines.push(...glossaryHintLines(hint, '    '));
  return lines.join('\n');
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderShowRecord(record) {
  const lines = [`${record.id} ${record.context} | ${quote(record.source)}`];
  for (const key of ['comment', 'extra']) {
    if (record[key] !== undefined) lines.push(`  ${key}: ${quote(record[key])}`);
  }
  for (const [language, entry] of Object.entries(record.translations ?? {})) {
    if (entry === null) {
      lines.push(`  ${language}: <absent>`);
      continue;
    }
    lines.push(`  ${language}: ${quote(entry.translation)} (${entry.state})`);
    if (entry.note !== undefined) lines.push(`      note: ${quote(entry.note)}`);
  }
  if (record.id_collision !== undefined) lines.push(`  ID COLLISION: ${quote(record.id_collision)}`);
  lines.push(`  at: ${(record.locations ?? []).join(', ') || '<none>'}`);
  if (record.build_locations) lines.push(`  (+${record.build_locations} build-tree locations)`);
  for (const hint of record.glossary ?? []) lines.push(...glossaryHintLines(hint, '  '));
  for (const excerpt of record.code ?? []) {
    lines.push(`  --- ${excerpt.location}`);
    lines.push(...(excerpt.lines ?? [excerpt.error ?? '']).map((line) => `    ${line}`));
  }
  return lines.join('\n');
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderFinding(record) {
  const parts = [
    String(record.severity).toUpperCase().padEnd(7),
    String(record.rule).padEnd(19),
    String(record.lang ?? '-').padEnd(6),
  ];
  if (record.id !== undefined) {
    parts.push(`${record.id} ${record.context} | ${quote(record.source)}`);
    if (record.translation !== undefined) parts.push(`=> ${quote(record.translation)}`);
  }
  parts.push(`: ${record.detail}`);
  if (record.line !== undefined) parts.push(`(line ${record.line})`);
  return parts.join(' ');
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderRule(record) {
  return `${String(record.severity).padEnd(8)} ${String(record.rule).padEnd(20)} ${record.description}`;
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderApplyRecord(record) {
  let head = `line ${record.line}: ${record.result}`;
  if (record.id !== undefined) head += ` ${record.id}`;
  if (record.context !== undefined) head += ` ${record.context} | ${quote(record.source)}`;
  const lines = [head];
  if (record.error !== undefined) lines.push(`    error: ${record.error}`);
  if (record.before !== undefined) lines.push(`    before: ${quote(record.before)}`);
  if (record.after !== undefined) lines.push(`    after:  ${quote(record.after)}`);
  for (const issue of record.issues ?? []) lines.push(`    ${issue.severity} ${issue.rule}: ${issue.detail}`);
  return lines.join('\n');
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderPruneRecord(record) {
  if (record.removed_messages !== undefined) {
    const written = record.written ? 'written' : 'not written';
    const contexts = record.removed_contexts?.length ? `, contexts: ${record.removed_contexts.join(', ')}` : '';
    return `${record.lang}: removed ${record.removed_messages} messages (${written})${contexts}`;
  }
  return `  - ${record.lang} ${record.id} ${record.context} | ${quote(record.source)}`;
}

/**
 * @param {object} record
 * @returns {string}
 */
export function renderSuggestions(record) {
  const query = record.query;
  if (record.error !== undefined) return `${query.id ?? ''}: ${record.error}`;
  const head = query.id !== undefined ? `${query.id} ${query.context} | ` : '';
  const lines = [`${head}${quote(query.source)}`];
  for (const match of record.matches ?? []) {
    const times = match.count > 1 ? ` x${match.count}` : '';
    lines.push(
      `  ${match.score.toFixed(3)} ${match.id} ${match.context}${times} | ${quote(match.source)} => ${quote(match.translation)} (${match.state})`,
    );
  }
  if ((record.matches ?? []).length === 0) lines.push('  no similar sources');
  return lines.join('\n');
}

/**
 * @param {object} record
 * @param {string} [indent]
 * @returns {string}
 */
export function renderTerm(record, indent = '') {
  if (record.query !== undefined) {
    const query = record.query;
    if (record.error !== undefined) return `${query.id ?? ''}: ${record.error}`;
    const head = query.id !== undefined ? `${query.id} ${query.context} | ` : '';
    const lines = [`${head}${quote(query.source)}`];
    for (const term of record.terms ?? []) lines.push(...renderTerm(term, '  ').split('\n').map((line) => `  ${line}`));
    if ((record.terms ?? []).length === 0) lines.push('  no glossary terms');
    return lines.join('\n');
  }
  const scope = record.contexts ? ` [contexts: ${record.contexts}]` : '';
  const lines = [`${quote(record.term)} (${record.status})${scope}`];
  if (record.note) lines.push(`    note: ${record.note}`);
  for (const [key, value] of Object.entries(record)) {
    if (['term', 'status', 'contexts', 'note', 'exceptions'].includes(key)) continue;
    const extras = ['variants', 'avoid', 'note'].filter((name) => value[name] !== undefined).map((name) => `${name}: ${quote(value[name])}`);
    const marker = value.status === 'proposed' ? ' PROPOSED' : '';
    lines.push(`    ${key}: ${quote(value.translation)}${marker}${extras.length > 0 ? `  (${extras.join('; ')})` : ''}`);
  }
  if (record.exceptions) lines.push(`    exceptions: ${record.exceptions.join(', ')}`);
  return lines.map((line) => `${indent}${line}`).join('\n');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function renderValue(value) {
  return JSON.stringify(value, null, 2);
}
