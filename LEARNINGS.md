# Learnings

Codebase-specific gotchas worth remembering. Add to this as they are discovered.

## `app.js` exists as two byte-identical copies

`app.js` (repo root) and `templates/app.js` are the same file. The build copies templates to
the root, but the root copy is also committed and served. **Any edit must be made to both**,
or the next build silently reverts it. Verify with `diff -q app.js templates/app.js`.

This is a strong reason to prefer solutions that keep the `data/index.json` schema frozen —
adding a manifest field means touching the client, which means touching both copies.

## The manifest `file` path is a localStorage key

`Store.isRead(email.file)` and `Store.isBookmarked(email.file)` key off the `file` string,
as does the `data-file` attribute. Renaming an output file orphans a user's read and
bookmark state for that email. Output filenames are effectively permanent once deployed.

This was tested for real on 2026-08-29, when all 16,989 paths moved from an 8-char
directory segment to the full message ID. It was survivable **only** because the old key
already contained the full ID in its filename, making the new key derivable client-side
with no lookup and no server state (`KeyMigration` in `app.js`). Had the old path not
carried that information, there would have been no way to migrate the state at all.

Two rules follow:

- **Keep an email's identity inside its own filename**, not only in the directory around
  it. The filename is what survives a reorganisation.
- **A key migration is permanent code.** It cannot be removed on a later cleanup pass —
  a browser that has not visited since the rename still holds the old keys.

Note the migration could not be perfect: 5 old keys embedded a *different* email's ID (see
below), which no string rule can invert. Those went inert.

## Independent tree walks drift

`collect_emails()` (which decides manifest paths) and the old `copy_html_emails()` (which
wrote files) each walked the source tree separately. They agreed only by coincidence — any
divergence in file selection would have produced manifest entries pointing at files that
were never written, i.e. dead links in the viewer.

Fixed 2026-08-29 by having the write step consume the collection result. **Keep it that
way**: if a new output kind is added, extend the record, do not add a third walk.

## Escaping order in the markdown renderer is load-bearing

`render_inline()` in `scripts/build_site.py` processes untrusted email bodies. The order is
deliberate and fragile:

1. `html.escape` **first** — nothing after this can inject markup, and URLs become safe to
   drop into an `href` without a second escaping pass.
2. Park code spans before emphasis, or `` `a *b* c` `` gets an `<em>` inside it.
3. Park anchors before autolinking, or a URL already wrapped by `[text](url)` gets linked a
   second time and you get `<a href="<a href=...">`.

Only `http:` / `https:` / `mailto:` may reach an `href`. Do not relax that to "any scheme".

## Plain-text bodies arrive as `.md` and need loose-list handling

The upstream ingestor writes the `text/plain` body into the `.md` file when HTML extraction
fails, so a "markdown" body is often just hard-wrapped plain text. Two consequences:

- Single newlines must render as `<br>` — 208 of the 400 such bodies have consecutive
  non-blank lines (sign-off blocks) that would otherwise run together.
- Numbered items are separated by blank lines. A blank line must **not** close a list, or
  each item becomes its own `<ol>` and renders "1. 1. 1.".

## Generated email pages must not carry a subject header

`extractPreviewText()` in `app.js` walks the entire document to build the inline preview and
hover tooltip. Anything at the top of the page — including a subject heading — is prepended
to every preview snippet. Real HTML emails have no header; generated pages must match.

## A silent wrong-body bug hid behind `sorted(...)[0]`

`collect_emails()` picks `sorted(html_files)[0]` for determinism. That is correct, but for
a long time it was also load-bearing in a way nobody intended.

Upstream, `newsletters/` directories were named by an 8-char truncation of the Gmail
message ID. Those IDs are time-ordered rather than hashed, so newsletters delivered minutes
apart collided, and the organizer's prefix-based raw-file lookup copied **both** emails'
bodies into **both** directories:

```
newsletters/Byrne/19731332/
    197313327f3340f8.html      <- Tyler Cowen's body
    1973133282ce4b60.html      <- Byrne's own body
    democratizing-..._19731332.md
```

One record per directory, `sorted(...)[0]`, and Byrne's headline shipped with Tyler Cowen's
body. Five emails were published this way and one was dropped entirely — with **zero**
warnings, in either repo, for months.

The deeper lesson is not about IDs. `sorted(...)[0]` quietly turned "there are two
candidates here, which is impossible" into a successful build. Where a data invariant
exists, assert it rather than picking a winner: `collect_emails()` now warns when a
directory holds more than one body, and the test suite covers both the ambiguous case and
the clean one (a warning nothing ever triggers is worthless, so the silent case is tested
too).

## Absence has no symptom

16 Psmith emails were missing from the site for months. Nothing was broken: no dead link,
no failed build, no console error. A malformed `from:` header upstream made their front
matter unparseable, the organizer skipped them, and they simply never existed downstream.

Manifest counts are the only thing that would have caught it. After a rebuild, reconcile
`total_emails` against the source (`find ../newsletters -mindepth 2 -maxdepth 2 -type d |
wc -l`) rather than trusting that the build "succeeded".

## Renaming 17k LFS files: use the index, not `git mv`

Git stores no rename information — renames are detected at diff time by content
similarity. So a mass rename produces an identical commit whether you `git mv`, or delete
and re-add. Only the cost differs.

`git mv` preserves the index entry (blob hash and all) without re-reading the file, which
avoids pushing 1.1 GB back through the LFS clean filter. But it rewrites the entire index
on every invocation — measured at ~60 ms each, so ~17 minutes for 17k files.

`git update-index --index-info` applies the same index edit in **one** pass: re-register
each blob at its new path with the same mode and SHA, drop the old path. Seconds instead of
minutes, with `git mv` semantics. Verify with `git diff --cached -M --name-status` — every
unchanged file should report `R100`.

For the 2026-08-29 rename that gave 16,984 pure renames, 5 rename+modify (the wrong-body
corrections) and 17 additions, for exactly 22 new objects.

## Stripping quotes is not parsing them

The front-matter parser matched a double-quoted scalar with `"((?:[^"\\]|\\.)*)"` — a
pattern that correctly *tolerates* escape sequences so the closing quote is not mistaken
for a delimiter, then handed the raw capture straight to the manifest. Tolerating an
escape and resolving it are different steps, and only the first was ever written.

The upstream ingestor quotes every value, so the bug fired on every subject containing a
quote: 396 subjects rendered as `Why I quit \"The Strive\"`, plus 3,152 `from:` values.
It stayed invisible for so long because each row shows the subject beside a body preview
extracted at runtime via `DOMParser` — the same words, one escaped and one not, and the
mismatch reads as a rendering quirk rather than a parse bug.

If a regex has an escape-aware character class, something downstream has to unescape.
`unescape_double_quoted()` now does, and passes unknown sequences through with the
backslash intact: this front matter comes from an ingestor we do not control, so odd input
should stay visible rather than lose a character.

Single-quoted YAML does **not** use backslashes — it escapes a quote by doubling it. The
old pattern applied backslash rules to both styles; they are now handled separately.

## One escape layer at a time

The 16 Psmith emails from "Absence has no symptom" have a display name that genuinely
contains quotes, so their `from:` is encoded twice: RFC 5322 quotes it, then YAML escapes
that. Unescaping the YAML layer correctly leaves `"\"Mr. and Mrs. Psmith's Bookshelf\""`.

That residue is not a parser bug — decoding a mail display name is a separate concern from
reading YAML, and `from` is not rendered anywhere in the UI. Resist the urge to keep
stripping backslashes until they are gone; you would corrupt names that really do contain
a quote.
