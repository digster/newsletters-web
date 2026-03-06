/* ============================================================
   Newsletter Archive — Client-Side App
   Handles search, filtering, navigation, and data loading.
   ============================================================ */

const App = (() => {
  let manifest = null;
  let debounceTimer = null;

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

  function renderNewsletterGrid(newsletters, container) {
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

      card.innerHTML = `
        <div class="card__name">${escapeHtml(nl.name)}</div>
        <div class="card__meta">
          <span class="card__count">${nl.count} email${nl.count !== 1 ? "s" : ""}</span>
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

      renderNewsletterGrid(data.newsletters, grid);

      if (searchInput) {
        searchInput.addEventListener(
          "input",
          debounce((e) => {
            const q = normalizeQuery(e.target.value);
            if (!q) {
              renderNewsletterGrid(data.newsletters, grid);
              return;
            }
            const filtered = data.newsletters.filter((nl) =>
              nl.name.toLowerCase().includes(q)
            );
            renderNewsletterGrid(filtered, grid);
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

  function renderEmailList(emails, container) {
    container.innerHTML = "";

    if (emails.length === 0) {
      container.innerHTML = '<div class="empty-state">No emails found.</div>';
      return;
    }

    emails.forEach((email) => {
      const item = document.createElement("a");
      item.href = viewerUrl(email.file, email.newsletter);
      item.className = "email-item";

      item.innerHTML = `
        <span class="email-item__date">${formatDate(email.date)}</span>
        <span class="email-item__subject">${escapeHtml(email.subject)}</span>
      `;
      container.appendChild(item);
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

    if (!file || !iframe) return;

    // Set iframe source
    iframe.src = file;

    // Back link
    if (backLink && newsletter) {
      backLink.href = newsletterUrl(newsletter);
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
    initKeyboard,
  };
})();
