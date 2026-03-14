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

    newsletters.forEach((nl) => {
      const card = document.createElement("a");
      card.href = newsletterUrl(nl.name);
      card.className = "card";
      card.setAttribute("data-name", nl.name.toLowerCase());

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
        <div class="card__name">${escapeHtml(nl.name)}</div>
        <div class="card__meta">
          <div>
            <span class="card__count">${nl.count} email${nl.count !== 1 ? "s" : ""}</span>
            ${readHtml}
          </div>
          <span class="card__dates">${dateRange}</span>
        </div>
      `;
      container.appendChild(card);
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
    initHomepage,
    initNewsletter,
    initViewer,
    initBookmarks,
    initKeyboard,
  };
})();
