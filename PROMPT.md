# Prompts

## 2026-03-07: Add "Random Email" Feature

Add a "Random" link on the homepage that navigates to a random email from the ~13.6K collection each time it's loaded. Create a lightweight `random.html` page that loads the manifest, picks a random email, and redirects to the viewer. Bookmarkable URL — each visit/refresh shows a different email. Add shuffle SVG icon in header next to Bookmarks link.

## 2026-03-05: Initial Implementation

Implement the GitHub Pages site for Newsletter Archive. Python build script + client-side JS approach. Build script reads from ../newsletters/, parses YAML front matter, copies HTML email files, generates JSON manifest. Three pages: homepage (card grid), newsletter listing (date-sorted emails), email viewer (iframe). Modern minimal UI with dark mode. GitHub Actions deployment.

## 2026-03-05: Fix GitHub Pages Deployment Error

Fix GitHub Pages deployment error by adding `enablement: true` to `actions/configure-pages@v5` in the workflow file, so Pages is auto-enabled on the repository.

## 2026-03-05: Diagnose and Revert Pages Auto-Enablement

why am i getting this error?

ok, remove the enablement option.

Implement the plan.

## 2026-03-06: Migrate Email Files to Git LFS

Migrate the 13,652 HTML email files (~883 MB) from regular git objects to Git LFS. Full history rewrite (only 3 commits, single branch). Update CI workflow with LFS checkout + caching. Update README with LFS prerequisite. Update ARCHITECTURE.md with LFS decision.

## 2026-03-06: Read Tracking & Bookmarks (Browser Storage)

Implement client-side read tracking and bookmarks using localStorage. Store module with Set cache, auto-mark-read on viewer open, bookmark toggle button in viewer, read state styling on email lists, read count on homepage cards, bookmarks badge in header, dedicated bookmarks page with search and newsletter labels.

## 2026-03-07: Inline Action Buttons on Email List Rows

Add interactive bookmark and read/unread toggle buttons directly on each email list row (newsletter page and bookmarks page). Buttons appear trailing on the right side of each row. Uses event delegation for efficiency with large lists. Clicking buttons toggles state without navigating to the email viewer.

## 2026-03-13: Add Input Directory CLI Argument to build_site.py

Add a CLI argument to `build_site.py` so the source newsletters directory can be specified at runtime instead of being hardcoded. Uses argparse with a positional optional argument (`nargs="?"`) defaulting to the existing `../newsletters/` path.
