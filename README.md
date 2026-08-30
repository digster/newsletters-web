# Newsletter Archive

A browsable GitHub Pages site for ~17,000 newsletter emails across 68 sources.

## How It Works

- **Source data**: The `newsletters/` repo contains raw email files (HTML, MD, TXT) organized by newsletter name and full Gmail message ID
- **Build script**: `scripts/build_site.py` reads the source repo, extracts metadata from YAML front matter in `.md` files, materializes one HTML file per email, and generates a JSON manifest
- **Markdown fallback**: emails that ship an `.html` body are copied verbatim. Emails with no `.html` (the ingestor writes none when HTML extraction fails) are rendered from their `.md` body instead, so they still appear on the site
- **Static site**: Pure HTML/CSS/JS with no build tools or frameworks. Client-side JS loads the manifest and renders navigation

## Prerequisites

- **Git LFS** is required. Email files (~883 MB) are stored with Git LFS.

```bash
git lfs install   # one-time setup
git clone <repo>  # LFS files are pulled automatically
```

If you already cloned without LFS, run `git lfs pull` to fetch the email files.

## Local Development

### Build the site

```bash
# From the newsletters-web directory
python scripts/build_site.py
```

This reads from `../newsletters/` and outputs:
- `emails/` — one HTML file per email (copied, or rendered from markdown)
- `data/index.json` — manifest with metadata for all emails
- `index.html`, `newsletter.html`, `view.html`, `style.css`, `app.js` — site templates

### Run tests

```bash
# Build script (Python, stdlib unittest)
python3 -m unittest discover -s scripts -p "test_*.py" -v

# localStorage key migration in app.js (Node's built-in runner)
node --test scripts/*.mjs
```

No dependencies to install for either — stdlib `unittest` and Node's built-in
`node:test`. Note `node --test scripts/` (a bare directory) also picks up the
Python test file and fails; pass the `*.mjs` glob.

### Serve locally

```bash
python -m http.server 8000
# Open http://localhost:8000
```

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Homepage | `index.html` | Card grid of all newsletters with search |
| Newsletter | `newsletter.html?name=Not+Boring` | Date-sorted email list for a newsletter |
| Viewer | `view.html?file=emails/...&newsletter=...` | Email rendered in iframe with prev/next nav |

## Deployment

GitHub Actions deploys the repo root to GitHub Pages on push to `main`. See `.github/workflows/deploy.yml`.

## Tech Stack

- Python 3.10+ (stdlib only — no dependencies)
- Vanilla HTML/CSS/JS
- GitHub Pages (static hosting)

## Email paths and stored state

Emails are addressed as `emails/{newsletter}/{message_id}/{message_id}.html`,
using the full 16-char Gmail message ID. That path is also the localStorage key
for read state and bookmarks, so **output filenames are effectively permanent
once deployed** — see `LEARNINGS.md`.

The middle segment was an 8-char truncation until 2026-08-29. `app.js` carries a
one-time `KeyMigration` that rewrites old keys in place; it must stay in the
codebase for browsers that have not loaded the site since.
