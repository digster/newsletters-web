# Architecture

## Overview

Newsletter Archive is a static site generator + client-side app for browsing ~14,000 email newsletters. It follows a "build once, render client-side" pattern with zero runtime dependencies.

## Data Flow

```
Source repo (../newsletters/)     Build script              GitHub Pages
  newsletters/                     scripts/build_site.py      Served as static files
    {name}/                          |
      {hash}/                        +-> emails/{name}/{hash}/{hash}.html  (copied HTML)
        {hash}.html                  +-> data/index.json                   (manifest)
        {hash}.md (metadata)         +-> index.html, newsletter.html, ...  (templates)
        {hash}.txt
```

1. Build script walks `../newsletters/`, parses YAML front matter from `.md` files
2. Copies only `.html` files to `emails/` (no `.md` or `.txt` — keeps size manageable)
3. Generates `data/index.json` with all email metadata (subject, from, date, file path)
4. Copies template files to repo root

## Key Design Decisions

- **No static site generator (Jekyll/Hugo)**: 14K HTML files already render perfectly. We only need ~70 navigation pages + 1 JSON manifest. Python stdlib handles this in ~10 seconds.
- **Client-side rendering**: `index.json` manifest is loaded once, then all navigation/search is client-side. No server needed.
- **Iframe email viewer**: Original HTML emails are loaded in sandboxed iframes to prevent CSS conflicts and preserve original formatting.
- **Repo root deployment**: Built files go directly to repo root (not `dist/`). The entire repo is deployed as a static site via GitHub Pages.

## File Structure

```
scripts/build_site.py       # Build script (reads source, generates output)
templates/                   # Source templates (copied to root on build)
  index.html                 # Homepage template
  newsletter.html            # Newsletter listing template
  view.html                  # Email viewer template
  style.css                  # Shared styles
  app.js                     # Client-side search/nav
data/index.json              # Generated manifest (all email metadata)
emails/                      # Copied HTML email files
.github/workflows/deploy.yml # GitHub Pages deployment
```

## Client-Side Architecture

`app.js` is organized as an IIFE module (`App`) with methods:
- `initHomepage()` — loads manifest, renders newsletter card grid, binds search
- `initNewsletter()` — filters manifest by newsletter name, renders date-sorted email list
- `initViewer()` — sets iframe src, loads prev/next navigation from manifest
- `initKeyboard()` — `/` to focus search, `Escape` to blur

All data comes from a single `data/index.json` fetch cached in memory.
