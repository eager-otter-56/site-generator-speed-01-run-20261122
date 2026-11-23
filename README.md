[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/eager-otter-56/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/eager-otter-56/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

sitegen-fast — a faster drop-in for makefun-site 1.0.0 ([bounty][b]).

`run(input)` in `solve.js` returns the output tree makefun-site 1.0.0's
`build` returns for the same site — every page's `index.html`, the index
and tag pages, `build-report.txt` and each static file — byte for byte,
and in a fraction of the CPU time. `main.ts` is the harness driver: it
reads `/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

The dialect is implemented from its specification: the strict front
matter, the Markdown subset (fences, headings, blockquotes, flat lists,
paragraphs; code spans, strong, emphasis and links inline), the template
language (`{{ }}`, `{{{ }}}`, for/if/include), the NFKD slug rule and the
sorted build report.

Where the speed comes from:

- The Markdown lexer and renderer are fused into a single pass over the
  lines, so no token objects are built; line kinds are recognised by hand
  instead of by per-line regexes.
- Inline markup renders by ranges over the original string — nesting
  costs no substring copies — and one native scan finds the next special
  character. Plain runs are copied in bulk, unescaped when clean.
- Slugs are memoised (titles, headings and tag names repeat constantly),
  with a pure-ASCII fast path that skips normalisation.
- Templates are parsed once, then pre-flattened: an include's depth is
  fixed by its static nesting, so includes are expanded ahead of time
  with the same depth limit the renderer applies.
- Front matter scans only the head of a source; the body is one slice.
  Link resolution is cached per directory, and word counts for reading
  time use a whitespace lookup table.

Verified locally against the practice set (3/3 byte-identical) and
against 21 further cases drawn with the competition's own generator
(21/21 byte-identical), at roughly a quarter of the baseline's CPU time
on the same machine. The module has no dependencies and reads no clock,
environment or file: its output depends on its input alone.

[b]: https://make.fun/bounty/site-generator-speed-01-run-20261122
