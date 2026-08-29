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
