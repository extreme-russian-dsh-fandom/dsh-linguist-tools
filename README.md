# dsh-linguist-tools

[English](README.md) · [Русский](README.ru.md)

A DSH Host plugin for Qt Linguist translation catalogs (`.ts` files). It gives
the agent eight tools and one skill, edits catalogs through a byte-exact
`lupdate` writer, and needs no Python, no `lupdate` binary, and no runtime
dependencies.

The engine is self-contained: tolerant XML parsing, stable message ids, the
five-state model, lint rules, an optional terminology glossary, and translation
memory. It works with any project layout and any language pair because nothing
about a specific product, language, or directory is hardcoded.

## Tools

| tool | purpose |
|------|---------|
| `qt_ts_status` | counts per state, cross-language gaps, format drift, write blockers |
| `qt_ts_find` | filter messages of one language by state/context/text/location/id |
| `qt_ts_show` | one message in every language, source locations, optional code excerpts |
| `qt_ts_lint` | placeholders, plurals, blank translations, mnemonics, markup, scripts, duplicates, desync, glossary |
| `qt_ts_apply` | validated all-or-nothing batch write of translations, states, and notes |
| `qt_ts_prune` | delete vanished/obsolete messages (dry run by default) |
| `qt_ts_memory` | existing translations of similar sources |
| `qt_ts_glossary` | list or look up terminology terms |

Every tool accepts `dir`; the default is `translations` relative to the
session directory. Languages resolve as `ru`, `ru_RU`, `zh`, a comma list,
`all`, or a `.ts` path. A message id is the first eight hex characters of
`sha1(context \0 source \0 comment)`, identical in every language file.

## Skill

The bundle also registers the `qt-linguist` skill. It describes the workflow
(status → lint → find → show → apply → lint), the five message states, the
`lupdate` boundary, translation quality rules, and the optional glossary.
Models can load it on demand; it does not consume prompt space otherwise.

## Safety

- Reads and writes go through `ctx.fs`, so the session sandbox and the
  read-before-write observation policy apply.
- A document is written only when every XML construct can be reproduced.
  Formatting-only deviations are reported as format drift and are normalized
  on the next write, exactly as `lupdate` would.
- `qt_ts_apply` validates the whole batch first: if any entry is rejected,
  nothing is written. `dry_run` previews. `force` overrides error-level issues.
- `qt_ts_prune` defaults to `dry_run: true`.
- The plugin never runs `lupdate` or `lrelease`; it only edits existing
  messages, their state, and translator comments.

## Glossary

`glossary.json` next to the `.ts` files is optional. The format:

```json
{
  "version": 1,
  "terms": [
    {
      "term": "probe",
      "note": "measuring probe",
      "ru": { "translation": "щуп", "match": "щуп\\w*", "variants": ["зонд"] },
      "zh": { "translation": "测头", "avoid": ["探头"] },
      "exceptions": ["2b8fe176"]
    }
  ]
}
```

- `status`: `approved` (default) or `proposed`.
- `match`: a regex accepting inflected forms; it defaults to the escaped
  translation for a rendering and to whole-word words for a term.
- `variants`, `avoid`, `note`, `contexts` (regex over context names), and
  `exceptions` (message ids) are optional.
- Terms are found longest-first, so `probe head` hides `probe`.

`qt_ts_lint` reports `glossary-avoid` (warning), `glossary` / `glossary-proposed`
(info), and `glossary-invalid` (error). `qt_ts_apply` rejects a batch whose
glossary is invalid.

## Repository layout

| path | contents |
|------|----------|
| `index.js` | plugin `apply`, service injection, skill registration |
| `lib/` | XML parser, serializer, model, queries, lint, glossary, editing, memory |
| `tools/` | the eight `qt_ts_*` tool registrations |
| `test/` | tests and synthetic fixtures (`test/fixtures/example/`, `test/fixtures/edge/`) |
| `scripts/generate-fixtures.mjs` | regenerates the fixtures |
| `locale/`, `icon.svg`, `cordis.patch.yml` | bundle display metadata and the Host row |

The repository root is the installable bundle; the engine lives in `lib/`.

## Configuration

The row config is optional; every key has a default:

```yaml
- id: dsh-linguist-tools
  name: dsh-linguist-tools
  config:
    translationsDir: translations
    glossaryFile: glossary.json
    buildDirectories: [build, out, dist]
    maxFileBytes: 16777216
    defaultLimit: 50
    maxLimit: 500
    codeContextRadius: 3
    allowWrites: true
```

## Install

The package is a normal pnpm dependency, so a GitHub ref or a local checkout
both work. In Desktop, use the Plugin Manager; from a shell:

```sh
# from GitHub (append #<branch-or-commit> to pin a revision)
dsh plugin --profile <profile> add github:extreme-russian-dsh-fandom/dsh-linguist-tools

# from a local checkout
dsh plugin --profile <profile> add C:\path\to\dsh-linguist-tools
```

`github:` is pnpm's GitHub shorthand, not a DSH-specific scheme: `dsh plugin`
forwards its arguments to pnpm, and the Plugin Manager's install path checks the
repository with `git ls-remote` before running `pnpm add`. A Git dependency is
versioned by the ref you name (or the default branch), so pin a tag, a commit,
or the branch that carries the plugin when the default branch does not have it
yet.

Repository: <https://github.com/extreme-russian-dsh-fandom/dsh-linguist-tools>.

Replace `<profile>` with your profile name (`desktop`, `web`, `tui`, ...).
Installing a local directory links it, so later edits need only a plugin
re-enable. Installing the GitHub spec copies the package: push first, then
reinstall to pick up changes.

The bundle patch inserts one row, `dsh-linguist-tools`. It has no dependencies
and no build step.

## Development

```
node --test --experimental-test-isolation=none "test/*.test.mjs"
```

Tests cover byte-for-byte round-trips, CRLF and entity edge cases, blocked and
conflicting catalogs, the glossary, lint rules, apply rejection rules,
all-or-nothing writes, and prune previews. The fixtures in
`test/fixtures/example/` are synthetic, cover every message state, and point
their locations at `test/fixtures/src/` so code excerpts work. Regenerate them
with `node scripts/generate-fixtures.mjs`; the `edge/` fixtures cover
unsupported constructs, merge conflicts, and formatting drift.

## Limits

- The writer reproduces the constructs `lupdate` writes. Unknown elements,
  unknown attributes, `<lengthvariant>`, and a serializer round-trip mismatch
  make the file read-only (`write-blocked`) instead of risking data loss.
- `lupdate` remains the only way to add messages and refresh locations.
- Similarity scoring uses Dice over character bigrams; scores are relative
  within this plugin and are not comparable with other translation-memory tools.
