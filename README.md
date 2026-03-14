# Newsletter Archive

A browsable GitHub Pages site for ~14,000 newsletter emails across 65+ sources.

## How It Works

- **Source data**: The `newsletters/` repo contains raw email files (HTML, MD, TXT) organized by newsletter name and hash prefix
- **Build script**: `scripts/build_site.py` reads the source repo, extracts metadata from YAML front matter in `.md` files, copies `.html` email files, and generates a JSON manifest
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
- `emails/` — copied HTML email files
- `data/index.json` — manifest with metadata for all emails
- `index.html`, `newsletter.html`, `view.html`, `style.css`, `app.js` — site templates

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
