# Architecture

## Overview

Newsletter Archive is a static site generator + client-side app for browsing ~17,000 email newsletters. It follows a "build once, render client-side" pattern with zero runtime dependencies.

## Data Flow

```
Source repo (../newsletters/)     Build script              GitHub Pages
  newsletters/                     scripts/build_site.py      Served as static files
    {name}/                          |
      {hash}/                        +-> emails/{name}/{hash}/{hash}.html  (copied, or
        {hash}.html                  |                                      rendered from .md)
        {hash}.md (metadata + body)  +-> data/index.json                   (manifest)
        {hash}.txt                   +-> index.html, newsletter.html, ...  (templates)
```

1. `collect_emails()` walks `../newsletters/`, parses YAML front matter from `.md` files,
   and picks the body for each email: the `.html` file if there is one, otherwise the `.md`
2. `write_emails()` materializes that list — copying real HTML verbatim, rendering
   markdown-only emails into generated HTML pages. `.txt` is never used as a body
3. Generates `data/index.json` with all email metadata (subject, from, date, file path)
4. Copies template files to repo root

Collection and writing are driven by a **single walk**: `collect_emails()` returns records
carrying internal `_source` / `_rel` keys, and `write_emails()` consumes that list rather
than re-walking the tree. This is what guarantees every manifest path exists on disk — with
two independent walks, a source file the two disagreed about would produce a dead link.

## Key Design Decisions

- **No static site generator (Jekyll/Hugo)**: 14K HTML files already render perfectly. We only need ~70 navigation pages + 1 JSON manifest. Python stdlib handles this in ~10 seconds.
- **Client-side rendering**: `index.json` manifest is loaded once, then all navigation/search is client-side. No server needed.
- **Iframe email viewer**: Original HTML emails are loaded in sandboxed iframes to prevent CSS conflicts and preserve original formatting.
- **Repo root deployment**: Built files go directly to repo root (not `dist/`). The entire repo is deployed as a static site via GitHub Pages.
- **Git LFS for emails**: The 16,989 HTML email files (~1.1 GB, including the 400 generated from markdown) are stored via Git LFS to keep clone size small (~4 MB pack vs 137 MB without LFS). `data/index.json` (3.1 MB) stays in regular git for delta compression and native diffing. The CI workflow caches `.git/lfs/` to minimize bandwidth usage on GitHub's free tier (1 GB/month).

### Markdown Fallback for HTML-less Emails

The upstream ingestor writes no `.html` file when HTML extraction fails, falling back to the
plain-text body in the `.md`. The build script used to `continue` past those directories,
silently dropping them — 400 emails, all in `Quincy`, which reduced a nine-year newsletter to
4 visible entries.

Those emails now render from their `.md` body instead:

- **`render_markdown()`** is a deliberately small stdlib converter (no PyYAML, no markdown
  dependency — matching the hand-rolled front-matter parser). It handles paragraphs, ordered
  and unordered lists, bare-URL autolinking, headings, `[text](url)` links, emphasis, code,
  blockquotes and rules. It is not, and does not try to be, CommonMark.
- **Escaping runs first.** Email bodies are untrusted, so `html.escape` is applied before any
  link or emphasis pass; nothing downstream can inject markup, and URLs are already safe to
  place in an `href`. Only `http:`, `https:` and `mailto:` schemes are emitted.
- **Already-rendered fragments are "parked"** behind NUL-delimited placeholders. Code spans
  are parked before emphasis so their contents stay literal, and anchors are parked before
  the autolink pass so a URL wrapped by `[text](url)` cannot be linked a second time.
- **A blank line does not close a list.** Every one of these bodies separates its numbered
  items with one; flushing eagerly emitted an `<ol>` per item and rendered "1. 1. 1.".
- **Generated pages carry no subject header.** Real HTML emails have none, the viewer chrome
  already shows subject and date, and a header would prepend duplicate subject text to every
  inline preview, since `extractPreviewText` walks the whole document.
- **Light-only styling**, because `.viewer-frame` is hardcoded to a white background and all
  copied emails render light — a dark variant would make these 400 the odd ones out.
- The generated file is named `{message_id}.html` after the sibling `.txt` stem, matching the
  convention real HTML emails use. That path doubles as the localStorage key for read and
  bookmark state, so it must stay stable once deployed.

Tests live in `scripts/test_build_site.py` (stdlib `unittest`, no dependencies):

```bash
python3 -m unittest discover -s scripts -p "test_*.py" -v
```

## File Structure

```
scripts/build_site.py       # Build script (reads source, generates output)
scripts/test_build_site.py  # Tests for the renderer and collection fallback
templates/                   # Source templates (copied to root on build)
  index.html                 # Homepage template
  newsletter.html            # Newsletter listing template
  view.html                  # Email viewer template
  bookmarks.html             # Bookmarks listing page
  style.css                  # Shared styles
  app.js                     # Client-side search/nav/storage
data/index.json              # Generated manifest (all email metadata)
emails/                      # Copied HTML email files
.github/workflows/deploy.yml # GitHub Pages deployment
```

## Client-Side Architecture

`app.js` is organized as an IIFE module (`App`) with methods:
- `initHomepage()` — loads manifest, renders newsletter card grid with read counts, binds search
- `initNewsletter()` — filters manifest by newsletter name, renders date-sorted email list with read/bookmark state
- `initViewer()` — sets iframe src, auto-marks email as read, loads prev/next navigation, bookmark toggle
- `initBookmarks()` — loads bookmarked emails from localStorage, renders with newsletter labels and search
- `initThemeToggle()` — initializes the theme toggle button (home page only), cycles through system/light/dark
- `initKeyboard()` — `/` to focus search, `Escape` to blur

Internal `Store` module provides localStorage-backed persistence with in-memory cache:
- **Set-based** (`_get`/`_save`): `nl_read` (read emails), `nl_bookmarks` (bookmarked emails) — JSON arrays serialized to Sets for O(1) lookups
- **Map-based** (`_getMap`/`_saveMap`): `nl_card_colors` (newsletter name → hex color) — JSON objects for key-value storage

All data comes from a single `data/index.json` fetch cached in memory.

### Theme Management

Three-state theme toggle (System / Light / Dark) on the home page header. Preference persisted in `localStorage` key `nl_theme` (`"light"`, `"dark"`, or absent for system auto). CSS uses `html[data-theme="dark"]` and `html[data-theme="light"]` attribute selectors to override the default `@media (prefers-color-scheme: dark)` media query when the user makes a manual choice. A synchronous inline `<script>` in every page's `<head>` sets the `data-theme` attribute before the stylesheet loads to prevent flash of wrong theme (FOUC). Internal `Theme` module in `app.js` manages state and cycling. Toggle button only on home page; preference respected on all pages.

### Card Color Picker

Homepage cards have a color picker swatch (top-right corner) that lets users customize each card's background. Uses a `<label>` wrapping a hidden `<input type="color">` — the label is the styled 16px circle, the native input provides the OS color picker. Card background is set via CSS custom property `--card-bg` (not inline `backgroundColor`) so that hover states in the stylesheet can reference and darken/lighten the color with `color-mix()`. Colors persist in `nl_card_colors` localStorage via the `Store._getMap`/`_saveMap` key-value methods. Event delegation on the grid container (`bindCardColorPickers`) prevents `<a>` navigation on click and live-updates the card on `input` events.

### Email Body Previews (Lazy Fetch)

Each row in an email list shows a Gmail-style inline preview (`subject — muted snippet`) plus a hover tooltip with the first few lines of the body after a 2-second sustained hover. Previews are generated client-side at runtime — the manifest (`data/index.json`) stays lean. The flow:

1. `renderEmailList` adds an empty `<span class="email-item__preview">` after the subject and calls `initPreviewObserver(container)` + `initPreviewTooltip(container)`.
2. An `IntersectionObserver` (rootMargin `200px`) notices rows as they scroll into view. For each, `fetchPreview(file)` fetches the HTML file, runs it through `extractPreviewText` (DOMParser-based; strips scripts/styles/hidden nodes, collapses whitespace, preserves block boundaries as line breaks), and caches a `{ short, long }` pair keyed by file path.
3. `short` (≤160 chars, single line) fills the inline span. `long` (≤500 chars, paragraph breaks preserved) fuels the hover tooltip. Both forms come from a single fetch.
4. Concurrent fetches are capped at 4 via a small queue (`PREVIEW_MAX_CONCURRENT`) and deduplicated via an in-flight map, preventing request stampedes on fast scrolling.
5. The hover tooltip is a single `<div class="preview-tooltip">` appended once to `<body>`, positioned absolutely below the row (flipped above when there's no room below) via `positionPreviewTooltip`. Delegated `mouseover`/`mouseout` listeners on the list container — with `relatedTarget` containment checks — avoid flicker across child elements.
6. Cache is in-memory only (page-lifetime `Map`); the browser's HTTP cache handles reuse across page navigations.

The feature piggybacks on the shared `renderEmailList`, so both the newsletter listing page and the bookmarks page get previews for free.

### List-Level Actions (Event Delegation)

Email list rows have inline action buttons (read toggle, bookmark toggle) that modify state without navigating to the viewer. This uses **event delegation**: a single click listener is attached to the list container (not per-button), and `e.target.closest("[data-action]")` identifies the clicked button. `e.preventDefault()` + `e.stopPropagation()` prevents the parent `<a>` link from navigating. The listener is bound once per container via a `_actionsListenerBound` flag to survive re-renders.

Row structure:
```html
<a class="email-item" data-file="emails/...">
  <span class="email-item__content">   <!-- baseline-aligned text wrapper -->
    <span class="email-item__date">...</span>
    <span class="email-item__subject">...</span>
  </span>
  <span class="email-item__actions">   <!-- right-aligned toggle buttons -->
    <button data-action="toggle-read">...</button>
    <button data-action="toggle-bookmark">...</button>
  </span>
</a>
```
