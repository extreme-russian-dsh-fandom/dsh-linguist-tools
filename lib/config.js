/**
 * Plugin configuration: defaults and validation.
 *
 * The bundle declares no `Config` schema, so `resolveConfig` validates the row
 * config itself. Every key is optional.
 */

export const DEFAULTS = Object.freeze({
  translationsDir: 'translations',
  glossaryFile: 'glossary.json',
  buildDirectories: ['build', 'out', 'dist'],
  maxFileBytes: 16 * 1024 * 1024,
  defaultLimit: 50,
  maxLimit: 500,
  codeContextRadius: 3,
  allowWrites: true,
});

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string}
 */
function stringValue(value, key) {
  if (typeof value !== 'string') throw new Error(`linguist-tools: ${key} must be a string`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string[]}
 */
function stringArray(value, key) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`linguist-tools: ${key} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function integerValue(value, key, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`linguist-tools: ${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Fill defaults and validate one row config.
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const config = { ...DEFAULTS, ...source };
  config.translationsDir = stringValue(config.translationsDir, 'translationsDir');
  if (config.translationsDir.trim().length === 0) throw new Error('linguist-tools: translationsDir must not be empty');
  config.glossaryFile = stringValue(config.glossaryFile, 'glossaryFile');
  config.buildDirectories = stringArray(config.buildDirectories, 'buildDirectories');
  config.maxFileBytes = integerValue(config.maxFileBytes, 'maxFileBytes', 1024, 256 * 1024 * 1024);
  config.defaultLimit = integerValue(config.defaultLimit, 'defaultLimit', 1, 5000);
  config.maxLimit = integerValue(config.maxLimit, 'maxLimit', 1, 5000);
  if (config.defaultLimit > config.maxLimit) {
    throw new Error('linguist-tools: defaultLimit must not exceed maxLimit');
  }
  config.codeContextRadius = integerValue(config.codeContextRadius, 'codeContextRadius', 0, 50);
  if (typeof config.allowWrites !== 'boolean') throw new Error('linguist-tools: allowWrites must be a boolean');
  return config;
}
