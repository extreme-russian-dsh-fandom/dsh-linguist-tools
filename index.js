/**
 * dsh-linguist-tools — Qt Linguist translation tools for DSH.
 *
 * Registers the `qt_ts_*` Host tools and the `qt-linguist` skill. The plugin
 * has no runtime dependencies and never invokes Python, lupdate, or lrelease.
 */

import { resolveConfig } from './lib/config.js';
import { SKILL } from './lib/skill.js';
import { registerTools } from './tools/index.js';

export const name = 'linguist-tools';

/** Services required to read, write, and locate translation files. */
export const inject = ['tools', 'fs', 'workingDirectory'];

/**
 * @param {any} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  registerTools(ctx, resolved);

  const registerSkill = (skillsCtx) => {
    skillsCtx.effect(() =>
      skillsCtx.skills.register({
        ...SKILL,
        source: 'runtime',
        provider: 'dsh-linguist-tools',
        invocation: { modelInvocable: true, userInvocable: true },
      }),
    );
  };
  if (typeof ctx.inject === 'function') ctx.inject(['skills'], registerSkill);
  else if (ctx.get('skills') !== undefined) registerSkill(ctx);
}
