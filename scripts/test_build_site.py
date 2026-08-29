#!/usr/bin/env python3
"""
Tests for the Newsletter Archive build script.

Stdlib unittest only, matching the build script's no-dependency constraint.

Run with:
    python3 -m unittest discover -s scripts -p "test_*.py" -v
"""

import logging
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_site  # noqa: E402


def setUpModule():
    # The build script logs at INFO; keep test output readable.
    build_site.log.setLevel(logging.CRITICAL)


FRONT_MATTER = """\
---
subject: "Test Subject"
from: "Someone <a@b.com>"
date: 2021-08-19 10:00:00
---
"""


def make_email(root: Path, newsletter: str, hash_dir: str, *,
               html: str | None = None,
               md: str | None = None,
               txt: str | None = None,
               md_name: str = "slug_abcd1234.md",
               stem: str = "1786999553523daa") -> Path:
    """Create one source email directory. Returns the directory path."""
    d = root / newsletter / hash_dir
    d.mkdir(parents=True)
    if html is not None:
        (d / f"{stem}.html").write_text(html, encoding="utf-8")
    if md is not None:
        (d / md_name).write_text(md, encoding="utf-8")
    if txt is not None:
        (d / f"{stem}.txt").write_text(txt, encoding="utf-8")
    return d


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


class TestRenderMarkdown(unittest.TestCase):

    def test_front_matter_is_stripped(self):
        out = build_site.render_markdown(FRONT_MATTER + "Hello there.")
        self.assertNotIn("subject:", out)
        self.assertIn("<p>Hello there.</p>", out)

    def test_blank_line_separates_paragraphs(self):
        out = build_site.render_markdown("First para.\n\nSecond para.")
        self.assertEqual(out, "<p>First para.</p>\n<p>Second para.</p>")

    def test_single_newline_becomes_br(self):
        # Sign-off blocks rely on this: consecutive hard-wrapped lines must not
        # run together. 208 of the 400 affected bodies contain such a pair.
        out = build_site.render_markdown(
            "Teacher at freeCodeCamp\nI share things on Twitter"
        )
        self.assertIn("Teacher at freeCodeCamp<br>I share things on Twitter", out)

    def test_dash_prefixed_line_is_a_bullet(self):
        # Documents a known ambiguity: an email sign-off written as
        # "- Quincy Larson" renders as a single-item list. That is what every
        # markdown renderer does, and guessing otherwise would be more
        # surprising than the bullet.
        out = build_site.render_markdown("Happy coding!\n\n- Quincy Larson")
        self.assertEqual(out, "<p>Happy coding!</p>\n<ul><li>Quincy Larson</li></ul>")

    def test_ordered_list(self):
        out = build_site.render_markdown("1. First\n2. Second")
        self.assertEqual(out, "<ol><li>First</li><li>Second</li></ol>")

    def test_unordered_list(self):
        out = build_site.render_markdown("- one\n- two")
        self.assertEqual(out, "<ul><li>one</li><li>two</li></ul>")

    def test_blank_line_separated_items_stay_one_list(self):
        # This is the exact shape of every affected body. Closing the list on
        # the blank line would emit three <ol>s and render "1. 1. 1.".
        out = build_site.render_markdown("1. First\n\n2. Second\n\n3. Third")
        self.assertEqual(out, "<ol><li>First</li><li>Second</li><li>Third</li></ol>")

    def test_paragraph_closes_an_open_list(self):
        out = build_site.render_markdown("1. a\n\nSome prose.\n\n1. b")
        self.assertEqual(
            out,
            "<ol><li>a</li></ol>\n<p>Some prose.</p>\n<ol><li>b</li></ol>",
        )

    def test_blank_line_then_other_list_type_closes_previous(self):
        out = build_site.render_markdown("1. a\n\n- b")
        self.assertEqual(out, "<ol><li>a</li></ol>\n<ul><li>b</li></ul>")

    def test_ordered_list_preserves_explicit_start(self):
        out = build_site.render_markdown("3. third\n\n4. fourth")
        self.assertEqual(out, '<ol start="3"><li>third</li><li>fourth</li></ol>')

    def test_switching_list_type_closes_previous(self):
        out = build_site.render_markdown("1. a\n- b")
        self.assertEqual(out, "<ol><li>a</li></ol>\n<ul><li>b</li></ul>")

    def test_bare_url_is_autolinked(self):
        out = build_site.render_markdown("See https://fcc.im/2unPHZJ now")
        self.assertIn('<a href="https://fcc.im/2unPHZJ" rel="noopener noreferrer">'
                      'https://fcc.im/2unPHZJ</a>', out)

    def test_autolink_trims_trailing_punctuation(self):
        out = build_site.render_markdown("(read: https://example.com/a).")
        self.assertIn('href="https://example.com/a"', out)
        self.assertNotIn('href="https://example.com/a).', out)
        self.assertTrue(out.rstrip().endswith(").</p>"))

    def test_autolink_keeps_entity_semicolon(self):
        # '&' escapes to '&amp;' — the trailing ';' belongs to the entity, not
        # to the sentence.
        out = build_site.render_markdown("https://example.com/?a=1&b=2")
        self.assertIn('href="https://example.com/?a=1&amp;b=2"', out)

    def test_markdown_link(self):
        out = build_site.render_markdown("[the docs](https://example.com/docs)")
        self.assertIn('<a href="https://example.com/docs" '
                      'rel="noopener noreferrer">the docs</a>', out)

    def test_markdown_link_is_not_double_linked(self):
        out = build_site.render_markdown("[x](https://example.com)")
        self.assertEqual(out.count("<a "), 1)

    def test_javascript_url_is_rejected(self):
        out = build_site.render_markdown("[click](javascript:alert(1))")
        self.assertNotIn("<a ", out)
        self.assertNotIn("javascript:alert(1)\"", out)

    def test_data_url_is_rejected(self):
        out = build_site.render_markdown("[x](data:text/html;base64,AAAA)")
        self.assertNotIn("<a ", out)

    def test_bold_and_italic(self):
        out = build_site.render_markdown("**loud** and *soft*")
        self.assertIn("<strong>loud</strong>", out)
        self.assertIn("<em>soft</em>", out)

    def test_emphasis_not_applied_inside_code_span(self):
        out = build_site.render_markdown("`a *b* c`")
        self.assertIn("<code>a *b* c</code>", out)
        self.assertNotIn("<em>", out)

    def test_fenced_code_is_escaped_and_not_inlined(self):
        out = build_site.render_markdown("```\n<b>x</b> *y*\n```")
        self.assertIn("<pre><code>&lt;b&gt;x&lt;/b&gt; *y*</code></pre>", out)

    def test_headings(self):
        out = build_site.render_markdown("# Big\n\n### Small")
        self.assertIn("<h1>Big</h1>", out)
        self.assertIn("<h3>Small</h3>", out)

    def test_horizontal_rule_beats_bullet(self):
        out = build_site.render_markdown("a\n\n---\n\nb")
        self.assertIn("<hr>", out)
        self.assertNotIn("<ul>", out)

    def test_blockquote(self):
        out = build_site.render_markdown("> quoted line\n> second line")
        self.assertIn("<blockquote>quoted line<br>second line</blockquote>", out)

    def test_html_is_escaped(self):
        out = build_site.render_markdown("<script>alert(1)</script>")
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)

    def test_ampersand_and_quotes_escaped(self):
        out = build_site.render_markdown('Tom & Jerry said "hi"')
        self.assertIn("&amp;", out)
        self.assertIn("&quot;", out)

    def test_empty_body(self):
        self.assertEqual(build_site.render_markdown(FRONT_MATTER), "")

    def test_unclosed_fence_does_not_hang(self):
        out = build_site.render_markdown("```\nno close")
        self.assertIn("<pre><code>no close</code></pre>", out)


class TestRenderEmailPage(unittest.TestCase):

    def test_page_is_self_contained(self):
        page = build_site.render_email_page("<p>hi</p>", "Subject")
        self.assertTrue(page.startswith("<!DOCTYPE html>"))
        self.assertIn("<style>", page)
        self.assertNotIn("<link", page)      # no external stylesheet
        self.assertNotIn("<script", page)    # iframe sandbox blocks scripts anyway
        self.assertIn("<p>hi</p>", page)

    def test_subject_is_escaped_in_title(self):
        page = build_site.render_email_page("", '<x> & "y"')
        self.assertIn("<title>&lt;x&gt; &amp; &quot;y&quot;</title>", page)

    def test_no_subject_header_in_body(self):
        # A visible header would prepend duplicate subject text to every
        # inline preview app.js generates.
        page = build_site.render_email_page("<p>body</p>", "My Subject")
        body = page.split("<body>", 1)[1]
        self.assertNotIn("My Subject", body)


# ---------------------------------------------------------------------------
# Collection + write
# ---------------------------------------------------------------------------


class TestCollectEmails(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_html_email_is_used_verbatim(self):
        make_email(self.root, "News", "aaaa1111",
                   html="<p>real</p>", md=FRONT_MATTER + "body", txt="body")
        (record,) = build_site.collect_emails(self.root)
        self.assertEqual(record["file"], "emails/News/aaaa1111/1786999553523daa.html")
        self.assertEqual(record["_source"].suffix, ".html")
        self.assertEqual(record["subject"], "Test Subject")

    def test_markdown_only_email_is_collected(self):
        make_email(self.root, "Quincy", "bbbb2222",
                   md=FRONT_MATTER + "body", txt="body")
        (record,) = build_site.collect_emails(self.root)
        self.assertEqual(record["_source"].suffix, ".md")
        # Named after the .txt stem, matching the {message_id}.html convention.
        self.assertEqual(record["file"], "emails/Quincy/bbbb2222/1786999553523daa.html")

    def test_markdown_only_email_keeps_its_metadata(self):
        make_email(self.root, "Quincy", "bbbb2222",
                   md=FRONT_MATTER + "body", txt="body")
        (record,) = build_site.collect_emails(self.root)
        self.assertEqual(record["subject"], "Test Subject")
        self.assertEqual(record["from"], "Someone <a@b.com>")
        self.assertEqual(record["date"], "2021-08-19")

    def test_markdown_without_txt_falls_back_to_md_stem(self):
        make_email(self.root, "Quincy", "cccc3333",
                   md=FRONT_MATTER + "body", md_name="my-slug_cccc3333.md")
        (record,) = build_site.collect_emails(self.root)
        self.assertEqual(record["file"], "emails/Quincy/cccc3333/my-slug_cccc3333.html")

    def test_directory_with_neither_html_nor_md_is_skipped(self):
        make_email(self.root, "News", "dddd4444", txt="orphan")
        self.assertEqual(build_site.collect_emails(self.root), [])

    def test_record_carries_internal_keys(self):
        make_email(self.root, "News", "aaaa1111", html="<p>x</p>")
        (record,) = build_site.collect_emails(self.root)
        self.assertIn("_source", record)
        self.assertIn("_rel", record)

    def test_manifest_record_drops_internal_keys(self):
        make_email(self.root, "News", "aaaa1111", html="<p>x</p>")
        (record,) = build_site.collect_emails(self.root)
        public = build_site.manifest_record(record)
        self.assertEqual(set(public), set(build_site.MANIFEST_KEYS))
        self.assertFalse([k for k in public if k.startswith("_")])

    def test_manifest_contains_no_internal_keys(self):
        make_email(self.root, "News", "aaaa1111", html="<p>x</p>")
        make_email(self.root, "Quincy", "bbbb2222", md=FRONT_MATTER + "b", txt="b")
        manifest = build_site.build_manifest(build_site.collect_emails(self.root))
        self.assertEqual(manifest["total_emails"], 2)
        for entry in manifest["emails"]:
            self.assertEqual(set(entry), set(build_site.MANIFEST_KEYS))


class TestWriteEmails(unittest.TestCase):

    def setUp(self):
        self._src = tempfile.TemporaryDirectory()
        self._out = tempfile.TemporaryDirectory()
        self.root = Path(self._src.name)
        self.out = Path(self._out.name) / "emails"
        self.addCleanup(self._src.cleanup)
        self.addCleanup(self._out.cleanup)

    def test_every_manifest_path_exists_on_disk(self):
        make_email(self.root, "News", "aaaa1111", html="<p>real</p>")
        make_email(self.root, "Quincy", "bbbb2222", md=FRONT_MATTER + "body", txt="body")
        records = build_site.collect_emails(self.root)
        build_site.write_emails(records, self.out)

        repo_root = self.out.parent
        for record in records:
            self.assertTrue((repo_root / record["file"]).exists(),
                            f"missing: {record['file']}")

    def test_html_is_copied_byte_identical(self):
        original = "<html><body><p>untouched &amp; intact</p></body></html>"
        make_email(self.root, "News", "aaaa1111", html=original)
        records = build_site.collect_emails(self.root)
        build_site.write_emails(records, self.out)
        written = (self.out / "News/aaaa1111/1786999553523daa.html").read_text()
        self.assertEqual(written, original)

    def test_markdown_is_rendered_into_a_page(self):
        make_email(self.root, "Quincy", "bbbb2222",
                   md=FRONT_MATTER + "1. See https://example.com/x", txt="x")
        records = build_site.collect_emails(self.root)
        build_site.write_emails(records, self.out)
        page = (self.out / "Quincy/bbbb2222/1786999553523daa.html").read_text()
        self.assertTrue(page.startswith("<!DOCTYPE html>"))
        self.assertIn("<ol><li>See <a href=\"https://example.com/x\"", page)

    def test_output_directory_is_cleaned_first(self):
        stale = self.out / "Old" / "zzzz9999" / "stale.html"
        stale.parent.mkdir(parents=True)
        stale.write_text("stale")
        make_email(self.root, "News", "aaaa1111", html="<p>x</p>")
        build_site.write_emails(build_site.collect_emails(self.root), self.out)
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
