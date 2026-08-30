# 2026-08-29 (session 2) — Rebuild for full Gmail message IDs

Downstream of `gmail-ingestor`'s migration to full 16-char message IDs and
`ingestor-tools`' rebuild of `../newsletters`.

## Path change

```
before  emails/{newsletter}/{message_id:0..8}/{message_id}.html
after   emails/{newsletter}/{message_id}/{message_id}.html
```

`hash` in the manifest is now the full message ID, and equals both the directory
name and the filename stem for all 17,006 records.

## Site totals

| | before | after |
|---|---|---|
| emails | 16,989 | **17,006** |
| newsletters | 68 | 68 |
| Psmith | 40 | 56 |

+16 previously-skipped Psmith emails (unparseable YAML upstream, now repaired),
+1 `Tyler Cowen/1953e3be` splitting in two ("Tuesday assorted links", which had
never been published), +3 carried-over `Ryan Holiday` orphans replacing their
3 old directories. 5 records had their **body corrected** — they had been
serving another newsletter's email under their own headline.

## `build_site.py`

`collect_emails()` now warns when a directory holds more than one `.html` or
`.md`. The `sorted(...)[0]` pick is unchanged (builds stay deterministic), but
the condition is now audible instead of silent — it is exactly the state that
produced the wrong-body bug. On the rebuilt tree it fires **zero** times.

## `app.js` — `KeyMigration` (permanent)

One-time localStorage migration for `nl_read` and `nl_bookmarks`, whose keys are
manifest `file` paths. New keys are derived client-side: replace the middle path
segment with the filename's stem. Guarded by `nl_key_schema` = `"2"`, written
last so a partial failure retries rather than half-applying. Idempotent by
construction (a key whose directory already equals its stem passes through).

Validated against all 16,989 real old keys: **16,984** map onto a live new key.
The 5 misses are the wrong-body records, whose old key embeds a *different*
email's ID — not invertible by any string rule, so they go inert. That is the
right outcome: the read mark was on a page showing the wrong body.

Edited in **both** `app.js` and `templates/app.js` (they must stay byte-identical
— see `LEARNINGS.md`); verified with `diff -q`.

## Git / LFS

Renamed via `git update-index --index-info` rather than 17k `git mv` calls
(~60 ms each ≈ 17 min). One pass, same semantics, seconds. Result:

- 16,984 `R100` pure renames
- 5 rename+modify (the corrected bodies)
- 17 additions
- **22 new objects total** (the brief estimated ~6; the 5 corrected bodies had
  never been published either)

## Tests: 43 → 48 Python, + 17 new Node

- `test_build_site.py`: two-`.html` directory yields one record deterministically
  and is reported; two-`.md` case; the clean case warns about nothing; full-ID
  directories stay separate with distinct hashes.
- `scripts/test_key_migration.mjs` (new, `node --test scripts/*.mjs`): loads the
  real `app.js` against a stubbed `localStorage`. Covers the rewrite rule,
  idempotency, the version flag, corrupt/non-array values, hostile storage, the
  flag staying unset on mid-migration failure, and that every current manifest
  key is already stable under the rule.

## Browser verification

Seeded a browser with pre-migration keys, reloaded, and confirmed: keys rewritten
and flag set; `Tyler Cowen` shows both halves of the split with read state landing
on the right one; Byrne's viewer renders Byrne's body (no Madrid leakage); a
restored Psmith email renders 18 KB of content; no console errors.

## Not committed

Both repos are staged but uncommitted, per project convention. `../newsletters-old`
holds the previous source tree as a backup.
