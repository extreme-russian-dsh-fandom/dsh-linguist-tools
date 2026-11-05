# Example Qt translation catalog

Synthetic catalogs for testing dsh-linguist-tools. They are not copied from any product.

- `example_en.ts` — source-language overrides (`Licence` → `License`); everything else is unfinished.
- `example_ru.ts` — one draft with a note (`Snapshot`), one untranslated entry (`Export report`),
  one vanished message, three plural forms.
- `example_zh_CN.ts` — one deliberate blank finished entry (`Tolerance`), one glossary `avoid` hit.
- `glossary.json` — full-parity terminology, including a context-scoped term and an exception.

The `<location>` paths point at `../src/`, so `qt_ts_show` code excerpts work.

Regenerate with `node scripts/generate-fixtures.mjs`.
