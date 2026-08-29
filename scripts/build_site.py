#!/usr/bin/env python3
"""
Build script for the Newsletter Archive GitHub Pages site.

Reads from ../newsletters/ (source repo, untouched), parses YAML front matter
from .md files for metadata, materializes one HTML file per email, generates a
JSON manifest, and copies template files into the repo root for GitHub Pages
deployment.

Emails that ship an .html body are copied verbatim. Emails that have no .html
body (the upstream ingestor writes none when HTML extraction fails) fall back to
their .md body, which is rendered into a self-contained HTML page here so the
email still appears on the site.
"""

import argparse
import html
import json
import logging
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
SOURCE_DIR = REPO_ROOT.parent / "newsletters"
TEMPLATES_DIR = REPO_ROOT / "templates"

# Output paths (repo root — GitHub Pages serves from here)
OUTPUT_EMAILS = REPO_ROOT / "emails"
OUTPUT_DATA = REPO_ROOT / "data"

# The manifest schema consumed by app.js. Collected records carry extra
# underscore-prefixed keys for internal bookkeeping; only these six are
# projected into data/index.json.
MANIFEST_KEYS = ("newsletter", "subject", "from", "date", "file", "hash")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("build")

# ---------------------------------------------------------------------------
# YAML front-matter parser (stdlib only — no PyYAML dependency)
# ---------------------------------------------------------------------------

FRONT_MATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)

# Matches key: "value" or key: value (unquoted)
YAML_LINE_RE = re.compile(
    r'^(\w[\w\s]*?):\s*'           # key
    r'(?:"((?:[^"\\]|\\.)*)"|'     # double-quoted value
    r"'((?:[^'\\]|\\.)*)'|"        # single-quoted value
    r'(.*))'                        # unquoted value
    r'\s*$'
)


def parse_front_matter(text: str) -> dict:
    """Extract YAML front matter from markdown text into a dict."""
    match = FRONT_MATTER_RE.match(text)
    if not match:
        return {}

    data = {}
    for line in match.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        m = YAML_LINE_RE.match(line)
        if m:
            key = m.group(1).strip()
            # Pick whichever capture group matched
            value = m.group(2) if m.group(2) is not None else (
                m.group(3) if m.group(3) is not None else m.group(4).strip()
            )
            data[key] = value

    return data


def strip_front_matter(text: str) -> str:
    """Return the markdown body with any leading YAML front matter removed."""
    return FRONT_MATTER_RE.sub("", text, count=1).lstrip("\n")


def parse_date(date_str: str) -> str | None:
    """Normalize a date string to ISO format (YYYY-MM-DD). Returns None on failure."""
    if not date_str:
        return None
    # Try common formats
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(date_str.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Markdown -> HTML rendering (stdlib only)
#
# Deliberately a small subset, sized to what these email bodies actually
# contain: paragraphs, lists and bare URLs, plus a cheap safe superset
# (headings, links, emphasis, code, quotes, rules) for future sources. This is
# not, and does not try to be, a CommonMark implementation.
# ---------------------------------------------------------------------------

# Block-level constructs, matched one line at a time.
FENCE_RE = re.compile(r"^\s*```")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
HR_RE = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")
QUOTE_RE = re.compile(r"^\s*>\s?(.*)$")
OL_RE = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
UL_RE = re.compile(r"^\s*[-*+]\s+(.*)$")

# Inline constructs. These run against already-escaped text, so `<` is `&lt;`
# and the patterns can never see or produce raw markup from the source.
CODE_SPAN_RE = re.compile(r"`([^`\n]+)`")
MD_LINK_RE = re.compile(r"\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)")
BARE_URL_RE = re.compile(r"\bhttps?://[^\s<>\"']+")
BOLD_RE = re.compile(r"\*\*(\S(?:[^*]*\S)?)\*\*")
ITALIC_RE = re.compile(r"(?<![\w*_])[*_](\S(?:[^*_]*\S)?)[*_](?![\w*_])")

# Parked fragments are addressed by index between NUL bytes. NUL cannot occur in
# escaped HTML text, so this can never collide with document content.
PLACEHOLDER_RE = re.compile(r"\x00(\d+)\x00")

# Email bodies are untrusted input: only these schemes may reach an href, which
# keeps `javascript:` and `data:` URLs out of the generated pages.
SAFE_URL_SCHEMES = ("http://", "https://", "mailto:")

# Punctuation that commonly follows a URL in prose rather than belonging to it.
TRAILING_PUNCT = ".,;:!?)]}>\"'"


def _is_safe_url(url: str) -> bool:
    """True if `url` uses a scheme we are willing to emit in an href."""
    return url.lower().startswith(SAFE_URL_SCHEMES)


def _anchor(url: str, text: str) -> str:
    """Build an anchor from already-escaped url/text.

    No target="_blank": the viewer iframe is sandboxed without allow-popups, so
    it would be ignored anyway.
    """
    return f'<a href="{url}" rel="noopener noreferrer">{text}</a>'


def _trim_url(url: str) -> tuple[str, str]:
    """Split trailing sentence punctuation off a bare URL.

    Returns (url, trailing). A ';' is given back when it turns out to be the
    tail of an HTML entity — escaping turns '&' into '&amp;', and a URL may
    legitimately end on a query parameter separator.
    """
    trailing = ""
    while url and url[-1] in TRAILING_PUNCT:
        trailing = url[-1] + trailing
        url = url[:-1]

    while trailing.startswith(";") and re.search(r"&#?\w+$", url):
        url += ";"
        trailing = trailing[1:]

    return url, trailing


def render_inline(text: str) -> str:
    """Render inline markdown in a single line of text.

    Ordering here is load-bearing:

    1. Escape first, so no later step can inject markup and so URLs are already
       safe to drop into an href attribute.
    2. Park code spans, so emphasis and autolinking never reach inside them.
    3. Convert explicit links, then autolink bare URLs — each parking its
       anchor immediately, which is what stops the autolink pass from
       re-linking a URL the explicit-link pass already wrapped.
    4. Apply emphasis, now that no URL or code content remains in the string.
    5. Restore the parked fragments.
    """
    parked: list[str] = []

    def park(fragment: str) -> str:
        parked.append(fragment)
        return f"\x00{len(parked) - 1}\x00"

    out = html.escape(text)

    out = CODE_SPAN_RE.sub(lambda m: park(f"<code>{m.group(1)}</code>"), out)

    def sub_md_link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2)
        if not _is_safe_url(url):
            return m.group(0)  # leave unsafe links as literal text
        return park(_anchor(url, label))

    out = MD_LINK_RE.sub(sub_md_link, out)

    def sub_bare_url(m: re.Match) -> str:
        url, trailing = _trim_url(m.group(0))
        if not url:
            return m.group(0)
        return park(_anchor(url, url)) + trailing

    out = BARE_URL_RE.sub(sub_bare_url, out)

    out = BOLD_RE.sub(r"<strong>\1</strong>", out)
    out = ITALIC_RE.sub(r"<em>\1</em>", out)

    # Loop because a parked fragment can itself contain a placeholder, e.g. a
    # link whose label was a code span. Bounded so a malformed body cannot spin.
    for _ in range(5):
        if "\x00" not in out:
            break
        out = PLACEHOLDER_RE.sub(lambda m: parked[int(m.group(1))], out)

    return out


def render_markdown(text: str) -> str:
    """Convert a markdown email body into a safe HTML fragment."""
    body = strip_front_matter(text).replace("\r\n", "\n").replace("\r", "\n")
    lines = body.split("\n")

    parts: list[str] = []
    para: list[str] = []
    list_tag: str | None = None
    list_items: list[str] = []
    list_start = 1

    def flush_paragraph() -> None:
        nonlocal para
        if para:
            # Single newlines inside a paragraph are meaningful here: these
            # bodies are hard-wrapped plain text, and collapsing the lines of a
            # signature block would run them together.
            parts.append("<p>" + "<br>".join(render_inline(l) for l in para) + "</p>")
            para = []

    def flush_list() -> None:
        nonlocal list_tag, list_items, list_start
        if list_tag:
            items = "".join(f"<li>{render_inline(i)}</li>" for i in list_items)
            # Preserve an explicit starting number, e.g. a list resuming at 3.
            attr = f' start="{list_start}"' if list_tag == "ol" and list_start != 1 else ""
            parts.append(f"<{list_tag}{attr}>{items}</{list_tag}>")
            list_tag, list_items, list_start = None, [], 1

    i = 0
    while i < len(lines):
        line = lines[i]

        # Fenced code: consumed verbatim, escaped, and never given to the
        # inline pass.
        if FENCE_RE.match(line):
            flush_paragraph()
            flush_list()
            i += 1
            code: list[str] = []
            while i < len(lines) and not FENCE_RE.match(lines[i]):
                code.append(lines[i])
                i += 1
            i += 1  # skip the closing fence (or run off the end, harmlessly)
            parts.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
            continue

        if not line.strip():
            # Deliberately does NOT close an open list. Every one of these
            # bodies separates its numbered items with a blank line, and
            # flushing here would emit a fresh <ol> per item, restarting the
            # numbering at 1 each time. Any non-list content below closes it.
            flush_paragraph()
            i += 1
            continue

        # Checked before the list patterns: "- - -" is a rule, not a bullet.
        if HR_RE.match(line):
            flush_paragraph()
            flush_list()
            parts.append("<hr>")
            i += 1
            continue

        m = HEADING_RE.match(line)
        if m:
            flush_paragraph()
            flush_list()
            level = len(m.group(1))
            parts.append(f"<h{level}>{render_inline(m.group(2).strip())}</h{level}>")
            i += 1
            continue

        if QUOTE_RE.match(line):
            flush_paragraph()
            flush_list()
            quoted: list[str] = []
            while i < len(lines) and QUOTE_RE.match(lines[i]):
                quoted.append(QUOTE_RE.match(lines[i]).group(1))
                i += 1
            parts.append(
                "<blockquote>" + "<br>".join(render_inline(q) for q in quoted) + "</blockquote>"
            )
            continue

        m = OL_RE.match(line)
        if m:
            flush_paragraph()
            if list_tag != "ol":
                flush_list()
                list_tag = "ol"
                list_start = int(m.group(1))
            list_items.append(m.group(2))
            i += 1
            continue

        m = UL_RE.match(line)
        if m:
            flush_paragraph()
            if list_tag != "ul":
                flush_list()
                list_tag = "ul"
            list_items.append(m.group(1))
            i += 1
            continue

        # Non-list content: this is where a deferred list close happens.
        flush_list()
        para.append(line.strip())
        i += 1

    flush_paragraph()
    flush_list()

    return "\n".join(parts)


# Light-only on purpose: .viewer-frame is hardcoded to a white background and
# every real HTML email renders light, so a dark variant would make these pages
# the odd ones out inside the viewer.
EMAIL_PAGE_CSS = """\
:root { color-scheme: light; }
body {
  margin: 0;
  padding: 2rem 1.5rem 4rem;
  background: #fff;
  color: #1a1a1a;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.email-body { max-width: 68ch; margin: 0 auto; }
.email-body > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre { margin: 0 0 1.15em; }
h1, h2, h3, h4, h5, h6 { margin: 1.8em 0 .6em; line-height: 1.3; font-weight: 600; }
h1 { font-size: 1.5em; } h2 { font-size: 1.3em; } h3 { font-size: 1.15em; }
ul, ol { padding-left: 1.5em; }
li { margin-bottom: .4em; }
a { color: #0b5fff; text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: #0844c2; }
blockquote {
  padding-left: 1em;
  border-left: 3px solid #e0e0e0;
  color: #555;
}
code {
  padding: .15em .35em;
  border-radius: 3px;
  background: #f2f2f2;
  font: .9em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
pre {
  padding: .9em 1em;
  border-radius: 6px;
  background: #f6f6f6;
  overflow-x: auto;
}
pre code { padding: 0; background: none; }
hr { margin: 2em 0; border: 0; border-top: 1px solid #e0e0e0; }
img { max-width: 100%; height: auto; }
"""


def render_email_page(body_html: str, subject: str) -> str:
    """Wrap a rendered markdown body in a self-contained HTML document.

    No subject/from/date header: real HTML emails have none, the viewer chrome
    already shows that metadata, and a header would prepend duplicate subject
    text to the inline previews app.js builds by walking the whole document.
    """
    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="UTF-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        f"<title>{html.escape(subject)}</title>\n"
        f"<style>\n{EMAIL_PAGE_CSS}</style>\n"
        "</head>\n"
        "<body>\n"
        f'<div class="email-body">\n{body_html}\n</div>\n'
        "</body>\n"
        "</html>\n"
    )


# ---------------------------------------------------------------------------
# Build logic
# ---------------------------------------------------------------------------


def collect_emails(source_dir: Path) -> list[dict]:
    """Walk the source newsletters directory and collect a record per email.

    Each record carries the public manifest fields plus two internal keys:
    `_source` (the file the email is built from) and `_rel` (its path under
    emails/). The write step consumes these instead of re-walking the tree, so
    the manifest and the files on disk cannot disagree.
    """
    records = []
    skipped = 0
    from_markdown = 0
    unusable = 0

    newsletter_dirs = sorted(
        [d for d in source_dir.iterdir() if d.is_dir() and not d.name.startswith(".")],
        key=lambda d: d.name.lower(),
    )

    for nl_dir in newsletter_dirs:
        newsletter_name = nl_dir.name
        count = 0
        md_count = 0

        for hash_dir in sorted(nl_dir.iterdir()):
            if not hash_dir.is_dir():
                continue

            # sorted() because glob returns filesystem order, and a handful of
            # directories hold more than one .html/.md — the pick must be stable
            # across machines and rebuilds.
            md_files = sorted(hash_dir.glob("*.md"))
            html_files = sorted(hash_dir.glob("*.html"))

            # Parse metadata first: it lives in the .md file and is recoverable
            # whether or not an HTML body exists.
            metadata = {}
            if md_files:
                try:
                    md_text = md_files[0].read_text(encoding="utf-8", errors="replace")
                    metadata = parse_front_matter(md_text)
                except Exception as e:
                    log.warning("Failed to parse %s: %s", md_files[0], e)
                    skipped += 1

            if html_files:
                source = html_files[0]
                out_name = source.name
            elif md_files:
                # Fall back to the markdown body. Name the generated file after
                # the message id (the .txt stem) so it matches the
                # {message_id}.html convention real HTML emails already use —
                # and note this path doubles as a localStorage key for read and
                # bookmark state, so it must stay stable once shipped.
                txt_files = sorted(hash_dir.glob("*.txt"))
                stem = txt_files[0].stem if txt_files else md_files[0].stem
                source = md_files[0]
                out_name = f"{stem}.html"
                md_count += 1
            else:
                log.warning("No .html or .md body in %s — skipping", hash_dir)
                unusable += 1
                continue

            subject = metadata.get("subject", Path(out_name).stem)
            from_addr = metadata.get("from", newsletter_name)
            date = parse_date(metadata.get("date", ""))

            rel = Path(newsletter_name) / hash_dir.name / out_name

            records.append({
                "newsletter": newsletter_name,
                "subject": subject,
                "from": from_addr,
                "date": date,
                "file": f"emails/{rel.as_posix()}",
                "hash": hash_dir.name,
                "_source": source,
                "_rel": rel,
            })
            count += 1

        if count > 0:
            if md_count:
                log.info("  %s: %d emails (%d rendered from markdown)",
                         newsletter_name, count, md_count)
            else:
                log.info("  %s: %d emails", newsletter_name, count)
        from_markdown += md_count

    if from_markdown:
        log.info("Rendered %d emails from markdown (no HTML version available)", from_markdown)
    if unusable:
        log.warning("Skipped %d emails with neither an .html nor an .md body", unusable)
    if skipped:
        log.warning("Skipped %d files due to parse errors", skipped)

    return records


def manifest_record(record: dict) -> dict:
    """Project a collected record down to the public manifest schema."""
    return {k: record[k] for k in MANIFEST_KEYS}


def build_manifest(records: list[dict]) -> dict:
    """Build the index.json manifest with per-newsletter stats."""
    newsletters = {}
    for record in records:
        name = record["newsletter"]
        if name not in newsletters:
            newsletters[name] = {
                "name": name,
                "count": 0,
                "earliest": None,
                "latest": None,
            }

        nl = newsletters[name]
        nl["count"] += 1

        if record["date"]:
            if nl["earliest"] is None or record["date"] < nl["earliest"]:
                nl["earliest"] = record["date"]
            if nl["latest"] is None or record["date"] > nl["latest"]:
                nl["latest"] = record["date"]

    return {
        "generated": datetime.now().isoformat(),
        "total_emails": len(records),
        "total_newsletters": len(newsletters),
        "newsletters": sorted(newsletters.values(), key=lambda n: n["name"].lower()),
        "emails": [manifest_record(r) for r in records],
    }


def write_emails(records: list[dict], output_dir: Path) -> None:
    """Materialize every collected email into output_dir.

    Real HTML bodies are copied verbatim; markdown-only emails are rendered into
    a generated page. Driven by the collection result rather than a second walk
    of the source tree, so every manifest path is guaranteed to exist on disk.
    """
    if output_dir.exists():
        log.info("Cleaning existing emails directory...")
        shutil.rmtree(output_dir)

    copied = 0
    rendered = 0

    for record in records:
        source = record["_source"]
        dest = output_dir / record["_rel"]
        dest.parent.mkdir(parents=True, exist_ok=True)

        if source.suffix == ".html":
            shutil.copy2(source, dest)
            copied += 1
        else:
            md_text = source.read_text(encoding="utf-8", errors="replace")
            page = render_email_page(render_markdown(md_text), record["subject"])
            dest.write_text(page, encoding="utf-8")
            rendered += 1

    log.info("Copied %d HTML email files, rendered %d from markdown", copied, rendered)


def copy_templates(templates_dir: Path, output_dir: Path):
    """Copy template files (HTML, CSS, JS) to the output directory."""
    for f in templates_dir.iterdir():
        if f.suffix in (".html", ".css", ".js"):
            dest = output_dir / f.name
            shutil.copy2(f, dest)
            log.info("Copied template: %s", f.name)


def write_nojekyll(output_dir: Path):
    """Create .nojekyll file to disable Jekyll processing on GitHub Pages."""
    nojekyll = output_dir / ".nojekyll"
    if not nojekyll.exists():
        nojekyll.touch()
        log.info("Created .nojekyll")


def main():
    # --- CLI argument parsing ---
    parser = argparse.ArgumentParser(
        description="Build the Newsletter Archive GitHub Pages site.",
    )
    parser.add_argument(
        "input_dir",
        nargs="?",
        default=str(SOURCE_DIR),
        help=(
            "Path to the newsletters source directory "
            f"(default: {SOURCE_DIR})"
        ),
    )
    args = parser.parse_args()

    # Resolve the input directory to an absolute path
    source_dir = Path(args.input_dir).resolve()

    log.info("=" * 60)
    log.info("Newsletter Archive — Site Builder")
    log.info("=" * 60)

    # Validate source directory
    if not source_dir.exists():
        log.error("Source directory not found: %s", source_dir)
        log.error("Expected the newsletters source repo at ../newsletters/")
        sys.exit(1)

    log.info("Source: %s", source_dir)
    log.info("Output: %s", REPO_ROOT)

    # Step 1: Collect email metadata
    log.info("\n--- Collecting email metadata ---")
    records = collect_emails(source_dir)
    log.info("Found %d emails total", len(records))

    # Step 2: Build and write manifest
    log.info("\n--- Building manifest ---")
    manifest = build_manifest(records)
    OUTPUT_DATA.mkdir(parents=True, exist_ok=True)
    manifest_path = OUTPUT_DATA / "index.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    log.info("Wrote manifest: %s (%d newsletters, %d emails)",
             manifest_path, manifest["total_newsletters"], manifest["total_emails"])

    # Step 3: Write email files (copy HTML, render markdown fallbacks)
    log.info("\n--- Writing email files ---")
    write_emails(records, OUTPUT_EMAILS)

    # Step 4: Copy templates to repo root
    log.info("\n--- Copying templates ---")
    copy_templates(TEMPLATES_DIR, REPO_ROOT)

    # Step 5: Ensure .nojekyll exists
    write_nojekyll(REPO_ROOT)

    log.info("\n--- Build complete! ---")
    log.info("Total: %d newsletters, %d emails", manifest["total_newsletters"], manifest["total_emails"])
    log.info("Serve locally: cd %s && python -m http.server 8000", REPO_ROOT)


if __name__ == "__main__":
    main()
