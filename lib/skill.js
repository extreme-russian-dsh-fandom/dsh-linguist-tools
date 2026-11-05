/**
 * The registered `qt-linguist` skill: a compact, project-independent workflow
 * for editing Qt Linguist translation catalogs.
 */

export const SKILL = Object.freeze({
  name: 'qt-linguist',
  description:
    'Inspect, translate, review, and lint Qt Linguist .ts translation files through the qt_ts_* tools. Use for any task touching UI translations: .ts files, tr()/QT_TRANSLATE_NOOP strings, translating UI text, translation review, removing vanished messages, or checking translations after lupdate.',
  whenToUse:
    'Any task that reads or changes Qt Linguist .ts files, adds translations for tr() strings, reviews translated UI text, or cleans catalogs after lupdate.',
  content: `# Qt Linguist translations with qt_ts_* tools

## Hard rules

- **Do not read, search, or edit \`.ts\` files directly.** They are large XML files, and hand edits change
  formatting that \`lupdate\` owns. All inspection goes through the \`qt_ts_*\` tools; all changes go through
  \`qt_ts_apply\` or \`qt_ts_prune\`.
- **\`qt_ts_apply\` is all-or-nothing.** Every entry is validated first. If any entry is rejected, nothing is
  written — fix the rejected entries and call again. Use \`dry_run\` when you want a preview.
- **Only \`lupdate\` adds messages and locations.** The tools cannot add a message that is missing from a file,
  repair \`<location>\` entries, or scan source code. When \`qt_ts_lint\` reports \`desync\`, tell the user that
  \`lupdate\` needs to run; do not invent the missing entries.
- **\`qt_ts_prune\` deletes data.** It defaults to \`dry_run: true\`. Preview first, report what would be removed,
  and only write when the user asked for it or confirms.
- **Do not run \`lupdate\` or \`lrelease\`** unless the user asks. Refreshing catalogs is a separate operation.

## States

| state | stored as | runtime meaning |
|-------|-----------|-----------------|
| \`translated\` | finished with text | the translation is used |
| \`draft\` | unfinished with text | the translation is used, but still needs review |
| \`untranslated\` | unfinished, empty | Qt shows the source text |
| \`blank\` | finished, empty | **bug**: Qt shows an empty string |
| \`vanished\` | \`type="vanished"\` / \`"obsolete"\` | no longer in the sources; prune it |

Never leave a finished translation empty. To keep a string untranslated, set an unfinished, empty translation
(omit \`state\` and pass \`"translation": ""\`) or copy the source text as finished when that is the project's
convention.

## Recipes

**Overview and health:**
1. \`qt_ts_status\` — per-file counts, missing messages across languages, format drift, write blockers.
2. \`qt_ts_lint\` — findings grouped by rule; add \`severity: "info"\` for everything.

**Translate what is missing:**
1. \`qt_ts_find\` with \`lang\` and \`state: "untranslated"\`; add \`with_langs: "en"\` for the source and
   \`locations: true\` when the context is unclear. Page with \`limit\`/\`offset\`.
2. For anything ambiguous, \`qt_ts_show\` with the id and \`code: 3\` to read the surrounding C++/UI code.
3. Check terminology: \`qt_ts_glossary\` with the ids or the source text; then \`qt_ts_memory\` to see how
   similar sources were translated.
4. Write a batch with \`qt_ts_apply\` (\`dry_run: true\` first when the batch is large).
5. Re-run \`qt_ts_lint\` for the changed language and report what was translated and what remains.

**Review a translation:** \`qt_ts_find\` with a \`context\` or \`source\` filter and \`with_langs\`, inspect
suspicious ones with \`qt_ts_show\`, and fix via \`qt_ts_apply\`. Lint rules \`identical\`, \`wrong-script\`,
\`no-native-script\`, and \`newlines\` are often intentional; read the context before "fixing" them.

**After lupdate:** \`qt_ts_status\` → preview \`qt_ts_prune\` → \`qt_ts_lint\` → review \`draft\` messages
(lupdate's same-text heuristic copies translations and marks them unfinished; confirm each with
\`"state": "finished"\` or fix it) → translate the new \`untranslated\` messages.

**Where is a string used:** \`qt_ts_find\` with \`source\` + \`locations: true\`, or \`qt_ts_show\` with the id
and \`code\`.

## Translation quality

- Keep every \`%1\`..\`%99\` and \`%n\` placeholder; order may change, the set may not.
- Keep \`&\` mnemonics (\`&&\` is a literal ampersand) and keep them in only one of source and translation.
- Keep leading/trailing whitespace, HTML tags, and plural form counts. Line breaks may be re-wrapped for
  labels.
- Comments: \`<comment>\` is part of the message key (disambiguation) and must not change. \`note\` in
  \`qt_ts_apply\` writes \`<translatorcomment>\`, which Qt Linguist shows to translators.
- If a translation is genuinely ambiguous, write the best rendering as \`unfinished\` and put the alternatives
  in \`note\`; list every such question in your reply. Once the user decides, apply the chosen text as
  \`finished\` and clear the note.
- Terminology: follow the glossary when it exists. Do not copy a low-quality vendor translation merely because
  it is published; prefer the project's existing consistent renderings.

## Glossary (optional)

\`glossary.json\` next to the \`.ts\` files. A term has per-language renderings (language keys such as \`ru\`,
\`zh\`):

\`\`\`json
{
  "version": 1,
  "terms": [
    {
      "term": "probe",
      "note": "measuring probe",
      "ru": { "translation": "щуп", "match": "щуп\\\\w*", "variants": ["зонд"] },
      "zh": { "translation": "测头", "avoid": ["探头"] },
      "exceptions": ["2b8fe176"]
    }
  ]
}
\`\`\`

- \`approved\` (default) means use this rendering; \`proposed\` means not decided yet. For a proposed term, use
  the proposed rendering and mention the decision to the user.
- \`match\` is a regex that accepts inflected forms. \`avoid\` lists known wrong renderings. \`contexts\` is a
  regex over context names for a context-scoped entry. \`exceptions\` lists message ids where the term means
  something else.
- Never use an \`avoid\` rendering. \`qt_ts_lint\` and \`qt_ts_apply\` report it.
- Editing the glossary is a normal JSON file edit. Add new terms as \`proposed\`; set \`approved\` only when the
  user confirms.

## Reporting

Finish with: which files changed and how many entries, what remains untranslated, lint findings that need a
decision, every \`unfinished\` question with its variants, and any \`desync\` or \`write-blocked\` file that needs
the user's attention.`,
});
