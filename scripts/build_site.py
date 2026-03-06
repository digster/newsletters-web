#!/usr/bin/env python3
"""
Build script for the Newsletter Archive GitHub Pages site.

Reads from ../newsletters/ (source repo, untouched), parses YAML front matter
from .md files for metadata, copies .html email files, generates a JSON manifest,
and copies template files into the repo root for GitHub Pages deployment.
"""

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
# Build logic
# ---------------------------------------------------------------------------


def collect_emails(source_dir: Path) -> list[dict]:
    """Walk the source newsletters directory and collect metadata for every email."""
    emails = []
    skipped = 0

    newsletter_dirs = sorted(
        [d for d in source_dir.iterdir() if d.is_dir() and not d.name.startswith(".")],
        key=lambda d: d.name.lower(),
    )

    for nl_dir in newsletter_dirs:
        newsletter_name = nl_dir.name
        count = 0

        for hash_dir in sorted(nl_dir.iterdir()):
            if not hash_dir.is_dir():
                continue

            # Find the .md metadata file
            md_files = list(hash_dir.glob("*.md"))
            html_files = list(hash_dir.glob("*.html"))

            if not html_files:
                continue

            html_file = html_files[0]

            # Parse metadata from .md front matter
            metadata = {}
            if md_files:
                try:
                    md_text = md_files[0].read_text(encoding="utf-8", errors="replace")
                    metadata = parse_front_matter(md_text)
                except Exception as e:
                    log.warning("Failed to parse %s: %s", md_files[0], e)
                    skipped += 1

            subject = metadata.get("subject", html_file.stem)
            from_addr = metadata.get("from", newsletter_name)
            date = parse_date(metadata.get("date", ""))

            # Relative path for the email in the output
            rel_path = f"emails/{newsletter_name}/{hash_dir.name}/{html_file.name}"

            emails.append({
                "newsletter": newsletter_name,
                "subject": subject,
                "from": from_addr,
                "date": date,
                "file": rel_path,
                "hash": hash_dir.name,
            })
            count += 1

        if count > 0:
            log.info("  %s: %d emails", newsletter_name, count)

    if skipped:
        log.warning("Skipped %d files due to parse errors", skipped)

    return emails


def build_manifest(emails: list[dict]) -> dict:
    """Build the index.json manifest with per-newsletter stats."""
    newsletters = {}
    for email in emails:
        name = email["newsletter"]
        if name not in newsletters:
            newsletters[name] = {
                "name": name,
                "count": 0,
                "earliest": None,
                "latest": None,
            }

        nl = newsletters[name]
        nl["count"] += 1

        if email["date"]:
            if nl["earliest"] is None or email["date"] < nl["earliest"]:
                nl["earliest"] = email["date"]
            if nl["latest"] is None or email["date"] > nl["latest"]:
                nl["latest"] = email["date"]

    return {
        "generated": datetime.now().isoformat(),
        "total_emails": len(emails),
        "total_newsletters": len(newsletters),
        "newsletters": sorted(newsletters.values(), key=lambda n: n["name"].lower()),
        "emails": emails,
    }


def copy_html_emails(source_dir: Path, output_dir: Path):
    """Copy only .html email files from source to output, preserving directory structure."""
    if output_dir.exists():
        log.info("Cleaning existing emails directory...")
        shutil.rmtree(output_dir)

    copied = 0
    for nl_dir in sorted(source_dir.iterdir()):
        if not nl_dir.is_dir() or nl_dir.name.startswith("."):
            continue

        for hash_dir in nl_dir.iterdir():
            if not hash_dir.is_dir():
                continue

            for html_file in hash_dir.glob("*.html"):
                dest = output_dir / nl_dir.name / hash_dir.name / html_file.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(html_file, dest)
                copied += 1

    log.info("Copied %d HTML email files", copied)


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
    log.info("=" * 60)
    log.info("Newsletter Archive — Site Builder")
    log.info("=" * 60)

    # Validate source directory
    if not SOURCE_DIR.exists():
        log.error("Source directory not found: %s", SOURCE_DIR)
        log.error("Expected the newsletters source repo at ../newsletters/")
        sys.exit(1)

    log.info("Source: %s", SOURCE_DIR)
    log.info("Output: %s", REPO_ROOT)

    # Step 1: Collect email metadata
    log.info("\n--- Collecting email metadata ---")
    emails = collect_emails(SOURCE_DIR)
    log.info("Found %d emails total", len(emails))

    # Step 2: Build and write manifest
    log.info("\n--- Building manifest ---")
    manifest = build_manifest(emails)
    OUTPUT_DATA.mkdir(parents=True, exist_ok=True)
    manifest_path = OUTPUT_DATA / "index.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    log.info("Wrote manifest: %s (%d newsletters, %d emails)",
             manifest_path, manifest["total_newsletters"], manifest["total_emails"])

    # Step 3: Copy HTML email files
    log.info("\n--- Copying HTML email files ---")
    copy_html_emails(SOURCE_DIR, OUTPUT_EMAILS)

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
