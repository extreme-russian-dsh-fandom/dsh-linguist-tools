/**
 * Translation memory: existing translations of similar source texts.
 *
 * Similarity is the Sørensen–Dice coefficient over character bigrams, with a
 * length-based upper bound so most candidates are rejected before the multiset
 * intersection. That reproduces the purpose of the original difflib-based
 * implementation (finding near-identical sources) without porting its exact
 * score.
 */

import { messageTexts, stateOf, State } from './model.js';

export const DEFAULT_MINIMUM_RATIO = 0.6;
export const DEFAULT_SUGGESTION_LIMIT = 8;

const CASE_ONLY_SCORE = 0.99;
const STATE_PREFERENCE = {
  [State.TRANSLATED]: 0,
  [State.DRAFT]: 1,
  [State.BLANK]: 2,
  [State.VANISHED]: 3,
};

/**
 * @param {string} text
 * @returns {Map<string, number>}
 */
function bigrams(text) {
  const counts = new Map();
  if (text.length === 0) return counts;
  if (text.length === 1) {
    counts.set(text, 1);
    return counts;
  }
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * Dice similarity of two strings.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function dice(left, right) {
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let intersection = 0;
  for (const [pair, count] of leftPairs) {
    const other = rightPairs.get(pair);
    if (other !== undefined) intersection += Math.min(count, other);
  }
  const total = left.length - 1 + (right.length - 1);
  if (total <= 0) return left === right ? 1 : 0;
  return (2 * intersection) / total;
}

/**
 * Similarity score for a query/candidate pair, or `null` below the threshold.
 * @param {string} query
 * @param {string} candidate
 * @param {number} minimum
 * @returns {number|null}
 */
export function similarity(query, candidate, minimum) {
  if (query === candidate) return 1;
  const left = query.toLowerCase();
  const right = candidate.toLowerCase();
  if (left === right) return CASE_ONLY_SCORE;
  const shortest = Math.min(left.length, right.length);
  const longest = Math.max(left.length, right.length);
  const upperBound = (2 * Math.max(0, shortest - 1)) / Math.max(1, left.length - 1 + right.length - 1);
  if (longest === 0 || upperBound < minimum) return null;
  const score = dice(left, right);
  return score >= minimum ? score : null;
}

/**
 * Messages of one language whose source resembles the query, best first.
 * @param {string} query
 * @param {import('./context.js').LoadedLanguage} language
 * @param {{excludeKey?: string|null, minimum?: number, limit?: number}} [options]
 * @returns {object[]}
 */
export function suggest(query, language, options = {}) {
  const minimum = options.minimum ?? DEFAULT_MINIMUM_RATIO;
  const limit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;
  const excludeKey = options.excludeKey ?? null;
  const scored = [];
  for (const context of language.document.contexts) {
    for (const message of context.messages) {
      const key = `${message.context}\0${message.source}\0${message.comment}`;
      if (key === excludeKey || messageTexts(message).every((text) => text.length === 0)) continue;
      const score = similarity(query, message.source, minimum);
      if (score !== null) scored.push({ score, message });
    }
  }
  scored.sort((left, right) => right.score - left.score || (STATE_PREFERENCE[stateOf(left.message)] ?? 9) - (STATE_PREFERENCE[stateOf(right.message)] ?? 9));

  const grouped = new Map();
  for (const { score, message } of scored) {
    const translation = message.numerus ? [...message.numerusForms] : message.translation;
    const groupKey = JSON.stringify([message.source, translation, stateOf(message)]);
    const existing = grouped.get(groupKey);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    if (grouped.size >= limit) continue;
    grouped.set(groupKey, {
      id: message.shortId,
      context: message.context,
      source: message.source,
      translation,
      state: stateOf(message),
      score: Math.round(score * 1000) / 1000,
      count: 1,
    });
  }
  return [...grouped.values()];
}
