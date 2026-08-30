/* ============================================================
   Newsletter Archive — Client-Side App
   Handles search, filtering, navigation, and data loading.
   ============================================================ */

const App = (() => {
  let manifest = null;
  let debounceTimer = null;

  // -----------------------------------------------------------
  // Persistent Storage (localStorage-backed with in-memory Set cache)
  // -----------------------------------------------------------

  const Store = {
    _cache: {},

    /** Load a localStorage key into a cached Set (only parses JSON once) */
    _get(key) {
      if (!this._cache[key]) {
        try {
          this._cache[key] = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
        } catch {
          this._cache[key] = new Set();
        }
      }
      return this._cache[key];
    },

    /** Persist the cached Set back to localStorage */
    _save(key) {
      localStorage.setItem(key, JSON.stringify([...this._cache[key]]));
    },

    // --- Read tracking ---
    isRead(file)     { return this._get("nl_read").has(file); },
    markRead(file)   { this._get("nl_read").add(file); this._save("nl_read"); },
    toggleRead(file) {
      const s = this._get("nl_read");
      s.has(file) ? s.delete(file) : s.add(file);
      this._save("nl_read");
      return s.has(file);
    },
    readCount(files) { const s = this._get("nl_read"); return files.filter(f => s.has(f)).length; },

    // --- Bookmarks ---
    isBookmarked(file) { return this._get("nl_bookmarks").has(file); },
    toggleBookmark(file) {
      const s = this._get("nl_bookmarks");
      s.has(file) ? s.delete(file) : s.add(file);
      this._save("nl_bookmarks");
      return s.has(file);
    },
    getBookmarks() { return [...this._get("nl_bookmarks")]; },

    // --- Key-value storage (for objects, not sets) ---
    _getMap(key) {
      if (!this._cache[key]) {
        try {
          this._cache[key] = JSON.parse(localStorage.getItem(key) || "{}");
        } catch {
          this._cache[key] = {};
        }
      }
      return this._cache[key];
    },

    _saveMap(key) {
      localStorage.setItem(key, JSON.stringify(this._cache[key]));
    },

    // --- Card colors ---
    getCardColor(name)        { return this._getMap("nl_card_colors")[name] || null; },
    setCardColor(name, color) { this._getMap("nl_card_colors")[name] = color; this._saveMap("nl_card_colors"); },
    removeCardColor(name)     { delete this._getMap("nl_card_colors")[name]; this._saveMap("nl_card_colors"); },
  };

  // -----------------------------------------------------------
  // One-time localStorage key migration (truncated dir -> full message id)
  //
  // Read and bookmark state is keyed by the manifest's `file` path. That path
  // changed when the ingestor stopped truncating Gmail message IDs:
  //
  //   before  emails/{newsletter}/{id:0..8}/{id}.html
  //   after   emails/{newsletter}/{id}/{id}.html
  //
  // The full ID was always present in the filename, so the new key is derivable
  // from the old one entirely client-side — replace the middle path segment
  // with the filename's stem. No manifest lookup, no network, no server state.
  //
  // Guarded by a version flag so it runs once per browser, and idempotent by
  // construction anyway: a key whose directory already equals its stem is
  // passed through untouched.
  //
  // Known limitation: a handful of old keys (5 of ~17k) addressed a body that
  // belonged to a *different* email — the truncated-ID collision copied the
  // wrong .html into the directory and the build published it. Their real ID
  // appears nowhere in the old key, so no string rule can recover it and they
  // simply go inert. Dropping a read mark on a page that showed the wrong body
  // is the correct outcome rather than a loss.
  // -----------------------------------------------------------

  const KeyMigration = {
    FLAG: "nl_key_schema",
    VERSION: "2",
    KEYS: ["nl_read", "nl_bookmarks"],

    /** emails/News/1a2b3c4d/1a2b3c4d5e6f7890.html
     *    -> emails/News/1a2b3c4d5e6f7890/1a2b3c4d5e6f7890.html */
    rewrite(key) {
      if (typeof key !== "string") return key;
      // Newsletter names never contain "/", so the shape is exactly 4 segments.
      const parts = key.split("/");
      if (parts.length !== 4 || parts[0] !== "emails" || !parts[3].endsWith(".html")) {
        return key;
      }
      const dir = parts[2];
      const stem = parts[3].slice(0, -".html".length);
      // Only rewrite a genuine truncation: the directory must be a strict
      // prefix of the stem. Anything else (already migrated, or unrecognised)
      // is left exactly as it is.
      if (dir === stem || !stem.startsWith(dir)) return key;
      parts[2] = stem;
      return parts.join("/");
    },

    run() {
      try {
        if (localStorage.getItem(this.FLAG) === this.VERSION) return;

        for (const key of this.KEYS) {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;  // corrupt entry: leave it for Store's own fallback
          }
          if (!Array.isArray(parsed)) continue;
          // Set() collapses any two old keys that map onto the same new one.
          const migrated = [...new Set(parsed.map(f => this.rewrite(f)))];
          localStorage.setItem(key, JSON.stringify(migrated));
        }

        // Written last: if anything above throws, the flag stays unset and the
        // migration is retried on the next load rather than half-applied.
        localStorage.setItem(this.FLAG, this.VERSION);
      } catch {
        /* localStorage unavailable (private mode, quota) — leave state alone */
      }
    },
  };

  // Runs at script load, before any init*() can read through Store's cache.
  KeyMigration.run();

  // -----------------------------------------------------------
  // Theme Management (three-state: system / light / dark)
  // -----------------------------------------------------------

  const Theme = {
    STORAGE_KEY: "nl_theme",

    /** Returns "light", "dark", or null (system/auto) */
    getStored() {
      try {
        const v = localStorage.getItem(this.STORAGE_KEY);
        return v === "light" || v === "dark" ? v : null;
      } catch { return null; }
    },

    /** Persist preference. Pass null to clear (revert to system). */
    setStored(theme) {
      try {
        if (theme) localStorage.setItem(this.STORAGE_KEY, theme);
        else localStorage.removeItem(this.STORAGE_KEY);
      } catch { /* localStorage unavailable */ }
    },

    /** Resolved theme: "light" or "dark" based on stored pref or system */
    getEffective() {
      const stored = this.getStored();
      if (stored) return stored;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },

    /** Apply theme to the document via data-theme attribute */
    apply(theme) {
      if (theme) {
        document.documentElement.dataset.theme = theme;
      } else {
        delete document.documentElement.dataset.theme;
      }
    },

    /** Cycle: system → light → dark → system. Returns new stored value (or null). */
    cycle() {
      const stored = this.getStored();
      let next;
      if (stored === null) next = "light";
      else if (stored === "light") next = "dark";
      else next = null;

      this.setStored(next);
      this.apply(next);
      return next;
    },
  };

  // -----------------------------------------------------------
  // SVG Icons (inline to avoid external dependencies)
  // -----------------------------------------------------------

  const ICON = {
    bookmarkOutline: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5h9v12L8 11l-4.5 3.5v-12z"/></svg>',
    bookmarkFilled: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5h9v12L8 11l-4.5 3.5v-12z"/></svg>',
    bookmarkSmall: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.5"><path d="M3.5 2.5h9v12L8 11l-4.5 3.5v-12z"/></svg>',
    eyeOpen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeClosed: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    themeSun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    themeMoon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    themeSystem: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  };

  // -----------------------------------------------------------
  // Data Loading
  // -----------------------------------------------------------

  async function loadManifest() {
    const resp = await fetch("data/index.json");
    if (!resp.ok) throw new Error(`Failed to load manifest: ${resp.status}`);
    manifest = await resp.json();
    return manifest;
  }

  function getManifest() {
    return manifest;
  }

  // -----------------------------------------------------------
  // URL Helpers
  // -----------------------------------------------------------

  function getParam(key) {
    return new URLSearchParams(window.location.search).get(key);
  }

  function newsletterUrl(name) {
    return `newsletter.html?name=${encodeURIComponent(name)}`;
  }

  function viewerUrl(file, newsletter) {
    let url = `view.html?file=${encodeURIComponent(file)}`;
    if (newsletter) url += `&newsletter=${encodeURIComponent(newsletter)}`;
    return url;
  }

  // -----------------------------------------------------------
  // Date Formatting
  // -----------------------------------------------------------

  function formatDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatDateShort(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  // -----------------------------------------------------------
  // Search
  // -----------------------------------------------------------

  function debounce(fn, ms = 200) {
    return (...args) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fn(...args), ms);
    };
  }

  function normalizeQuery(q) {
    return q.toLowerCase().trim();
  }

  // -----------------------------------------------------------
  // Homepage: Newsletter Grid
  // -----------------------------------------------------------

  function renderNewsletterGrid(newsletters, container, allEmails) {
    container.innerHTML = "";

    if (newsletters.length === 0) {
      container.innerHTML = '<div class="empty-state">No newsletters found.</div>';
      return;
    }

    // Detect theme for default color picker value
    const defaultColor = Theme.getEffective() === "dark" ? "#181a20" : "#ffffff";

    newsletters.forEach((nl) => {
      const card = document.createElement("a");
      card.href = newsletterUrl(nl.name);
      card.className = "card";
      card.setAttribute("data-name", nl.name.toLowerCase());

      // Apply stored card color (if any)
      const cardColor = Store.getCardColor(nl.name);
      if (cardColor) {
        card.style.setProperty("--card-bg", cardColor);
      }

      const dateRange =
        nl.earliest && nl.latest
          ? `${formatDateShort(nl.earliest)} — ${formatDateShort(nl.latest)}`
          : "";

      // Compute read count for this newsletter
      let readHtml = "";
      if (allEmails) {
        const nlFiles = allEmails
          .filter((e) => e.newsletter === nl.name)
          .map((e) => e.file);
        const read = Store.readCount(nlFiles);
        if (read > 0) {
          readHtml = `<span class="card__read-count">${read} / ${nl.count} read</span>`;
        }
      }

      card.innerHTML = `
        <label class="card__color-picker${cardColor ? " card__color-picker--active" : ""}" title="Pick card color">
          <input type="color" class="card__color-input"
                 value="${cardColor || defaultColor}"
                 data-newsletter="${escapeHtml(nl.name)}">
        </label>
        <div class="card__name">${escapeHtml(nl.name)}</div>
        <div class="card__meta">
          <div>
            <span class="card__count">${nl.count} email${nl.count !== 1 ? "s" : ""}</span>
            ${readHtml}
          </div>
          <span class="card__dates">${dateRange}</span>
        </div>
      `;

      // Set swatch background to show current color
      if (cardColor) {
        const picker = card.querySelector(".card__color-picker");
        if (picker) picker.style.backgroundColor = cardColor;
      }

      container.appendChild(card);
    });
  }

  /** Event delegation for card color pickers — prevents navigation and handles color changes */
  function bindCardColorPickers(container) {
    if (container._colorListenerBound) return;
    container._colorListenerBound = true;

    // Prevent clicks on the color picker from navigating the <a> card
    container.addEventListener("click", (e) => {
      const picker = e.target.closest(".card__color-picker");
      if (picker) {
        e.preventDefault();
        e.stopPropagation();
        // preventDefault blocks <label>'s native activation, so trigger manually
        const input = picker.querySelector(".card__color-input");
        if (input) input.click();
      }
    });

    // Live-update card background as user picks a color
    container.addEventListener("input", (e) => {
      if (!e.target.classList.contains("card__color-input")) return;

      const color = e.target.value;
      const name = e.target.dataset.newsletter;
      const card = e.target.closest(".card");
      const picker = e.target.closest(".card__color-picker");

      // Apply to card via CSS custom property (preserves hover behavior)
      card.style.setProperty("--card-bg", color);

      // Update swatch to show current color
      picker.style.backgroundColor = color;
      picker.classList.add("card__color-picker--active");

      // Persist
      Store.setCardColor(name, color);
    });
  }

  function initHomepage() {
    const grid = document.getElementById("newsletter-grid");
    const searchInput = document.getElementById("search");
    const statsEl = document.getElementById("stats");

    if (!grid) return;

    grid.innerHTML = '<div class="loading">Loading newsletters...</div>';

    loadManifest().then((data) => {
      if (statsEl) {
        statsEl.textContent = `${data.total_newsletters} newsletters · ${data.total_emails.toLocaleString()} emails`;
      }

      renderNewsletterGrid(data.newsletters, grid, data.emails);
      bindCardColorPickers(grid);

      // Update bookmarks badge count
      updateBookmarksBadge();

      if (searchInput) {
        searchInput.addEventListener(
          "input",
          debounce((e) => {
            const q = normalizeQuery(e.target.value);
            if (!q) {
              renderNewsletterGrid(data.newsletters, grid, data.emails);
              return;
            }
            const filtered = data.newsletters.filter((nl) =>
              nl.name.toLowerCase().includes(q)
            );
            renderNewsletterGrid(filtered, grid, data.emails);
          })
        );
      }
    }).catch((err) => {
      grid.innerHTML = `<div class="empty-state">Failed to load data. Run the build script first.</div>`;
      console.error(err);
    });
  }

  // -----------------------------------------------------------
  // Newsletter Page: Email List
  // -----------------------------------------------------------

  function renderEmailList(emails, container, options = {}) {
    container.innerHTML = "";

    if (emails.length === 0) {
      const msg = options.emptyMessage || "No emails found.";
      container.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }

    emails.forEach((email) => {
      const item = document.createElement("a");
      item.href = viewerUrl(email.file, email.newsletter);
      item.className = "email-item";
      item.setAttribute("data-file", email.file);

      const isRead = Store.isRead(email.file);
      const isBookmarked = Store.isBookmarked(email.file);

      if (isRead) item.classList.add("email-item--read");

      // Optionally show newsletter name (for bookmarks page)
      const nlLabel = options.showNewsletter
        ? `<span class="email-item__newsletter">${escapeHtml(email.newsletter)}</span>`
        : "";

      item.innerHTML = `
        <span class="email-item__content">
          <span class="email-item__date">${formatDate(email.date)}</span>
          ${nlLabel}
          <span class="email-item__subject">${escapeHtml(email.subject)}</span>
          <span class="email-item__preview" aria-hidden="true"></span>
        </span>
        <span class="email-item__actions">
          <button type="button" class="email-item__action-btn${isRead ? " email-item__action-btn--active" : ""}"
                  data-action="toggle-read" title="${isRead ? "Mark as unread" : "Mark as read"}">
            ${isRead ? ICON.eyeOpen : ICON.eyeClosed}
          </button>
          <button type="button" class="email-item__action-btn${isBookmarked ? " email-item__action-btn--active" : ""}"
                  data-action="toggle-bookmark" title="${isBookmarked ? "Remove bookmark" : "Bookmark"}">
            ${isBookmarked ? ICON.bookmarkFilled : ICON.bookmarkOutline}
          </button>
        </span>
      `;
      container.appendChild(item);
    });

    // Bind event delegation for action buttons (once per container)
    bindListActions(container);

    // Lazy-load inline previews as rows enter viewport + hover tooltip
    initPreviewObserver(container);
    initPreviewTooltip(container);
  }

  /** Event delegation handler for inline action buttons in email lists */
  function bindListActions(container) {
    if (container._actionsListenerBound) return;
    container._actionsListenerBound = true;

    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      // Prevent navigation to viewer
      e.preventDefault();
      e.stopPropagation();

      const row = btn.closest(".email-item");
      const file = row?.getAttribute("data-file");
      if (!file) return;

      const action = btn.getAttribute("data-action");

      if (action === "toggle-read") {
        const nowRead = Store.toggleRead(file);
        btn.innerHTML = nowRead ? ICON.eyeOpen : ICON.eyeClosed;
        btn.title = nowRead ? "Mark as unread" : "Mark as read";
        btn.classList.toggle("email-item__action-btn--active", nowRead);
        row.classList.toggle("email-item--read", nowRead);
      }

      if (action === "toggle-bookmark") {
        const nowBookmarked = Store.toggleBookmark(file);
        btn.innerHTML = nowBookmarked ? ICON.bookmarkFilled : ICON.bookmarkOutline;
        btn.title = nowBookmarked ? "Remove bookmark" : "Bookmark";
        btn.classList.toggle("email-item__action-btn--active", nowBookmarked);
        updateBookmarksBadge();
      }
    });
  }

  // -----------------------------------------------------------
  // Email Body Previews (lazy fetch + inline snippet + hover tooltip)
  // -----------------------------------------------------------
  // Strategy: emails are served as static HTML files. When a row enters the
  // viewport we fetch its HTML once, extract a plain-text preview, and cache
  // both a single-line snippet (for inline display after the subject) and a
  // longer paragraph-preserving excerpt (for the hover tooltip). Fetches are
  // capped to PREVIEW_MAX_CONCURRENT to avoid bursting on fast scroll.

  const PreviewCache = new Map();     // file -> { short, long }
  const PreviewInflight = new Map();  // file -> Promise<{short, long}>
  const PreviewQueue = [];            // deferred runners when at capacity
  let previewActive = 0;

  const PREVIEW_MAX_CONCURRENT = 4;
  const PREVIEW_HOVER_DELAY_MS = 1400;
  const PREVIEW_SHORT_CHARS = 160;
  const PREVIEW_LONG_CHARS = 500;

  /** Truncate to word boundary where possible, appending an ellipsis. */
  function truncatePreview(text, max) {
    if (!text) return "";
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    const trimmed = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
    return trimmed.trimEnd() + "…";
  }

  /**
   * Parse an email's HTML and extract a { short, long } preview pair.
   * `short` is a single-line snippet; `long` preserves paragraph breaks
   * (block elements collapse to newlines). Non-visible nodes are stripped.
   */
  function extractPreviewText(html) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
      return { short: "", long: "" };
    }
    const body = doc.body;
    if (!body) return { short: "", long: "" };

    // Strip non-rendering and explicitly hidden elements
    body.querySelectorAll("script, style, noscript, link, meta, template, [hidden]")
      .forEach((el) => el.remove());
    body.querySelectorAll('[style*="display:none" i], [style*="display: none" i]')
      .forEach((el) => el.remove());

    // Walk the DOM and emit one line per block element; collapse whitespace runs.
    const blockTags = /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|LI|UL|OL|TR|TD|TH|H[1-6]|BLOCKQUOTE|PRE|HR|FIGURE)$/;
    const lines = [];
    let buffer = "";

    const flush = () => {
      const cleaned = buffer.replace(/\s+/g, " ").trim();
      if (cleaned) lines.push(cleaned);
      buffer = "";
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += " " + node.nodeValue;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") { flush(); return; }
      const isBlock = blockTags.test(node.tagName);
      if (isBlock) flush();
      for (const child of node.childNodes) walk(child);
      if (isBlock) flush();
    };

    walk(body);
    flush();

    const longRaw = lines.join("\n\n").trim();
    const shortRaw = lines.join(" ").replace(/\s+/g, " ").trim();

    return {
      short: truncatePreview(shortRaw, PREVIEW_SHORT_CHARS),
      long: truncatePreview(longRaw, PREVIEW_LONG_CHARS),
    };
  }

  /** Fetch + cache a preview for a single email file (deduped, throttled). */
  function fetchPreview(file) {
    if (PreviewCache.has(file)) return Promise.resolve(PreviewCache.get(file));
    const inflight = PreviewInflight.get(file);
    if (inflight) return inflight;

    const promise = new Promise((resolve) => {
      const run = () => {
        previewActive++;
        fetch(file)
          .then((r) => (r.ok ? r.text() : ""))
          .catch(() => "")
          .then((text) => {
            const preview = text ? extractPreviewText(text) : { short: "", long: "" };
            PreviewCache.set(file, preview);
            PreviewInflight.delete(file);
            previewActive--;
            resolve(preview);
            const next = PreviewQueue.shift();
            if (next) next();
          });
      };
      if (previewActive < PREVIEW_MAX_CONCURRENT) run();
      else PreviewQueue.push(run);
    });

    PreviewInflight.set(file, promise);
    return promise;
  }

  /**
   * Observe rows in a list container and populate their inline preview
   * snippet the first time they come into view. Safe to call repeatedly;
   * reuses a single observer per container and re-scans on each call.
   */
  function initPreviewObserver(container) {
    if (!("IntersectionObserver" in window)) return;

    if (container._previewObserver) container._previewObserver.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const row = entry.target;
          observer.unobserve(row);

          const file = row.getAttribute("data-file");
          const slot = row.querySelector(".email-item__preview");
          if (!file || !slot || slot.textContent) continue;

          fetchPreview(file).then(({ short }) => {
            if (short && !slot.textContent) slot.textContent = short;
          });
        }
      },
      { root: null, rootMargin: "200px 0px" }
    );

    container.querySelectorAll(".email-item").forEach((row) => observer.observe(row));
    container._previewObserver = observer;
  }

  /** Shared tooltip element (one per page) for hover previews. */
  let _previewTooltipEl = null;
  function ensurePreviewTooltipEl() {
    if (_previewTooltipEl) return _previewTooltipEl;
    const el = document.createElement("div");
    el.className = "preview-tooltip";
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    document.body.appendChild(el);
    _previewTooltipEl = el;
    return el;
  }

  /** Position the tooltip below the row, flipping above and clamping to the viewport. */
  function positionPreviewTooltip(el, rowRect) {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Measure natural size while rendered but visually hidden.
    // Uses `visibility: hidden` (still in layout tree) rather than the `hidden`
    // attribute (removed from layout) so offsetWidth/offsetHeight are valid.
    el.hidden = false;
    el.style.visibility = "hidden";
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    el.style.visibility = "";

    let top = rowRect.bottom + margin;
    let left = rowRect.left;

    if (left + tw > vw - margin) left = vw - margin - tw;
    if (left < margin) left = margin;

    if (top + th > vh - margin) {
      const flipped = rowRect.top - th - margin;
      if (flipped >= margin) top = flipped;
      else top = Math.max(margin, vh - margin - th);
    }

    el.style.top = top + window.scrollY + "px";
    el.style.left = left + window.scrollX + "px";
  }

  /** Delegated hover tooltip: shows after PREVIEW_HOVER_DELAY_MS of sustained hover. */
  function initPreviewTooltip(container) {
    if (container._previewTooltipBound) return;
    container._previewTooltipBound = true;

    let hoverTimer = null;
    let activeRow = null;

    const hideTooltip = () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      activeRow = null;
      const el = _previewTooltipEl;
      if (!el) return;
      el.removeAttribute("data-visible");
      // Leave display removed until fade-out completes
      setTimeout(() => {
        if (!el.hasAttribute("data-visible")) el.hidden = true;
      }, 150);
    };

    container.addEventListener("mouseover", (e) => {
      const row = e.target.closest(".email-item");
      if (!row || row === activeRow) return;

      // Switched rows mid-hover: reset state
      if (activeRow || hoverTimer) hideTooltip();

      activeRow = row;
      const file = row.getAttribute("data-file");
      if (!file) return;

      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        fetchPreview(file).then(({ long }) => {
          if (activeRow !== row || !long) return;
          const el = ensurePreviewTooltipEl();
          el.textContent = long;
          el.hidden = false;
          positionPreviewTooltip(el, row.getBoundingClientRect());
          requestAnimationFrame(() => el.setAttribute("data-visible", "true"));
        });
      }, PREVIEW_HOVER_DELAY_MS);
    });

    container.addEventListener("mouseout", (e) => {
      const row = e.target.closest(".email-item");
      if (!row || row !== activeRow) return;
      // mouseout also fires moving between child elements — ignore those
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      hideTooltip();
    });

    // Kill the tooltip on any interaction that changes layout or intent
    container.addEventListener("mousedown", hideTooltip);
    window.addEventListener("scroll", hideTooltip, { passive: true });
    window.addEventListener("resize", hideTooltip);
  }

  function initNewsletter() {
    const name = getParam("name");
    const listEl = document.getElementById("email-list");
    const titleEl = document.getElementById("newsletter-title");
    const breadcrumbEl = document.getElementById("breadcrumb");
    const searchInput = document.getElementById("search");

    if (!name || !listEl) return;

    if (titleEl) titleEl.textContent = name;
    if (breadcrumbEl) breadcrumbEl.textContent = name;
    document.title = `${name} — Newsletter Archive`;

    listEl.innerHTML = '<div class="loading">Loading emails...</div>';

    loadManifest().then((data) => {
      // Filter emails for this newsletter, sort by date descending
      let emails = data.emails.filter((e) => e.newsletter === name);
      emails.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.localeCompare(a.date);
      });

      const countEl = document.getElementById("email-count");
      if (countEl) countEl.textContent = `${emails.length} emails`;

      renderEmailList(emails, listEl);

      if (searchInput) {
        searchInput.addEventListener(
          "input",
          debounce((e) => {
            const q = normalizeQuery(e.target.value);
            if (!q) {
              renderEmailList(emails, listEl);
              return;
            }
            const filtered = emails.filter((em) =>
              em.subject.toLowerCase().includes(q)
            );
            renderEmailList(filtered, listEl);
          })
        );
      }
    }).catch((err) => {
      listEl.innerHTML = `<div class="empty-state">Failed to load data.</div>`;
      console.error(err);
    });
  }

  // -----------------------------------------------------------
  // Email Viewer
  // -----------------------------------------------------------

  function initViewer() {
    const file = getParam("file");
    const newsletter = getParam("newsletter");
    const iframe = document.getElementById("email-frame");
    const subjectEl = document.getElementById("viewer-subject");
    const dateEl = document.getElementById("viewer-date");
    const backLink = document.getElementById("back-link");
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    const bookmarkBtn = document.getElementById("bookmark-btn");
    const readBtn = document.getElementById("read-btn");

    if (!file || !iframe) return;

    // Set iframe source
    iframe.src = file;

    // Auto-mark email as read
    Store.markRead(file);

    // Back link
    if (backLink && newsletter) {
      backLink.href = newsletterUrl(newsletter);
    }

    // Read toggle button
    if (readBtn) {
      updateReadBtn(readBtn, file);
      readBtn.addEventListener("click", () => {
        Store.toggleRead(file);
        updateReadBtn(readBtn, file);
      });
    }

    // Bookmark toggle button
    if (bookmarkBtn) {
      updateBookmarkBtn(bookmarkBtn, file);
      bookmarkBtn.addEventListener("click", () => {
        Store.toggleBookmark(file);
        updateBookmarkBtn(bookmarkBtn, file);
      });
    }

    // Load metadata for this email + adjacent navigation
    loadManifest().then((data) => {
      const email = data.emails.find((e) => e.file === file);
      if (email) {
        if (subjectEl) subjectEl.textContent = email.subject;
        if (dateEl) dateEl.textContent = formatDate(email.date);
        document.title = `${email.subject} — Newsletter Archive`;
      }

      // Find prev/next within the same newsletter
      if (newsletter && prevBtn && nextBtn) {
        let siblings = data.emails
          .filter((e) => e.newsletter === newsletter)
          .sort((a, b) => {
            if (!a.date) return 1;
            if (!b.date) return -1;
            return b.date.localeCompare(a.date);
          });

        const idx = siblings.findIndex((e) => e.file === file);

        if (idx > 0) {
          prevBtn.href = viewerUrl(siblings[idx - 1].file, newsletter);
        } else {
          prevBtn.setAttribute("aria-disabled", "true");
        }

        if (idx >= 0 && idx < siblings.length - 1) {
          nextBtn.href = viewerUrl(siblings[idx + 1].file, newsletter);
        } else {
          nextBtn.setAttribute("aria-disabled", "true");
        }
      }
    });
  }

  /** Update the read toggle button icon and active state */
  function updateReadBtn(btn, file) {
    const read = Store.isRead(file);
    btn.innerHTML = read ? ICON.eyeOpen : ICON.eyeClosed;
    btn.classList.toggle("viewer-nav__btn--active", read);
    btn.title = read ? "Mark as unread" : "Mark as read";
  }

  /** Update the bookmark button icon and active state */
  function updateBookmarkBtn(btn, file) {
    const active = Store.isBookmarked(file);
    btn.innerHTML = active ? ICON.bookmarkFilled : ICON.bookmarkOutline;
    btn.classList.toggle("viewer-nav__btn--active", active);
    btn.title = active ? "Remove bookmark" : "Bookmark";
  }

  /** Update the bookmarks badge in the header (if present) */
  function updateBookmarksBadge() {
    const badge = document.getElementById("bookmarks-badge");
    if (!badge) return;
    const count = Store.getBookmarks().length;
    badge.textContent = count > 0 ? count : "";
    badge.style.display = count > 0 ? "" : "none";
  }

  // -----------------------------------------------------------
  // Bookmarks Page
  // -----------------------------------------------------------

  function initBookmarks() {
    const listEl = document.getElementById("bookmarks-list");
    const searchInput = document.getElementById("search");

    if (!listEl) return;

    listEl.innerHTML = '<div class="loading">Loading bookmarks...</div>';

    loadManifest().then((data) => {
      const bookmarkedFiles = Store.getBookmarks();
      let bookmarked = data.emails.filter((e) => bookmarkedFiles.includes(e.file));

      // Sort by date descending
      bookmarked.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.localeCompare(a.date);
      });

      const countEl = document.getElementById("bookmarks-count");
      if (countEl) countEl.textContent = `${bookmarked.length} bookmarked`;

      const emptyMsg = "No bookmarks yet. Bookmark emails from the viewer.";
      renderEmailList(bookmarked, listEl, { showNewsletter: true, emptyMessage: emptyMsg });

      if (searchInput) {
        searchInput.addEventListener(
          "input",
          debounce((e) => {
            const q = normalizeQuery(e.target.value);
            if (!q) {
              renderEmailList(bookmarked, listEl, { showNewsletter: true, emptyMessage: emptyMsg });
              return;
            }
            const filtered = bookmarked.filter(
              (em) =>
                em.subject.toLowerCase().includes(q) ||
                em.newsletter.toLowerCase().includes(q)
            );
            renderEmailList(filtered, listEl, { showNewsletter: true, emptyMessage: emptyMsg });
          })
        );
      }
    }).catch((err) => {
      listEl.innerHTML = '<div class="empty-state">Failed to load data.</div>';
      console.error(err);
    });
  }

  // -----------------------------------------------------------
  // Utility
  // -----------------------------------------------------------

  function escapeHtml(str) {
    if (!str) return "";
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }

  // -----------------------------------------------------------
  // Theme Toggle (home page only)
  // -----------------------------------------------------------

  /** Returns the icon SVG for the current stored theme state */
  function getThemeIcon(stored) {
    if (stored === "light") return ICON.themeSun;
    if (stored === "dark") return ICON.themeMoon;
    return ICON.themeSystem;
  }

  /** Returns the tooltip text for the current stored theme state */
  function getThemeTitle(stored) {
    if (stored === "light") return "Theme: Light — click for Dark";
    if (stored === "dark") return "Theme: Dark — click for System";
    return "Theme: System — click for Light";
  }

  function initThemeToggle() {
    const btn = document.getElementById("theme-toggle-btn");
    if (!btn) return;

    // Set initial icon based on stored preference
    const stored = Theme.getStored();
    btn.innerHTML = getThemeIcon(stored);
    btn.title = getThemeTitle(stored);

    // Click cycles through system → light → dark → system
    btn.addEventListener("click", () => {
      const next = Theme.cycle();
      btn.innerHTML = getThemeIcon(next);
      btn.title = getThemeTitle(next);
    });

    // When OS preference changes and user is in "system" mode, update icon
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!Theme.getStored()) {
        btn.innerHTML = getThemeIcon(null);
      }
    });
  }

  // -----------------------------------------------------------
  // Keyboard Navigation
  // -----------------------------------------------------------

  function initKeyboard() {
    document.addEventListener("keydown", (e) => {
      // Focus search with /
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const search = document.getElementById("search");
        if (search && document.activeElement !== search) {
          e.preventDefault();
          search.focus();
        }
      }

      // Escape to blur search
      if (e.key === "Escape") {
        const search = document.getElementById("search");
        if (search && document.activeElement === search) {
          search.blur();
        }
      }
    });
  }

  // -----------------------------------------------------------
  // Public API
  // -----------------------------------------------------------

  return {
    KeyMigration,
    initHomepage,
    initNewsletter,
    initViewer,
    initBookmarks,
    initKeyboard,
    initThemeToggle,
  };
})();
