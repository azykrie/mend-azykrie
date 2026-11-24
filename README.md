# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/azykrie/mend-azykrie/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/azykrie/mend-azykrie/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format: a command-line tool that applies an edit an AI model wrote
to a tree of text files, in any of four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON — and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch
  is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the
  default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

An edit names old lines O that are replaced by new lines N. O is found in the file's current lines at the first
of three tiers at which it occurs at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are removed from both.

So a patch still applies when the model drifted the whitespace or indentation of the lines it names. At tier 2
the new lines are re-indented to the file's own indentation. With `--strict` only tier 0 is tried.

## Output

- Exit 0: one line per changed path (`A` added, `D` deleted, `M` modified, `R old -> new` moved), then
  `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`; no file is written.
- Exit 2: a single `error: usage`, `error: no-patch`, `error: format` or `error: parse <N>` line.

`SPEC.md` is the whole contract. `runner.ts` is the kit's runner, kept as it is; `check.ts` runs the public
practice set (`node check.ts <practice.json>`). Node 22, standard library only, deterministic.

## Practice score

100 of 100 practice checks pass (practice score 1000): unified 30/30, search-replace 20/20, v4a 20/20,
json 15/15, cli 15/15, on Node 22.21.0 and Node 24.22.1.

## License

MIT. See `LICENSE`.
