/**
 * Tests for EmailLinks in app.js — making links inside the viewer's email
 * iframe open in a new tab — and for the iframe sandbox that allows it.
 *
 * Node's built-in test runner and assert, no npm packages, matching the rest
 * of scripts/. There is no DOM here, so documents and links are small stubs
 * exposing only the surface EmailLinks touches (querySelectorAll,
 * get/setAttribute, URL, baseURI, readyState). URL resolution uses Node's
 * WHATWG URL, the same parser browsers use.
 *
 * Run with:
 *     node --test scripts/*.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const EMAIL_URL = "https://digster.github.io/newsletters-web/emails/Not%20Boring/1824a0789694ffd7/1824a0789694ffd7.html";

/**
 * Load app.js with stubbed browser globals. `requestAnimationFrame` queues
 * callbacks instead of running them, so tests step frames explicitly.
 */
function loadApp() {
  const frames = [];
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const src = fs.readFileSync(path.join(REPO_ROOT, "app.js"), "utf8") + "\nreturn App;";
  const App = new Function("localStorage", "document", "window", "requestAnimationFrame", src)(
    localStorage, undefined, { matchMedia: () => ({ matches: false }) }, cb => frames.push(cb));
  const step = () => frames.splice(0).forEach(cb => cb());
  return { EmailLinks: App.EmailLinks, frames, step };
}

/** A link stub backed by a plain attribute map. */
function link(attrs) {
  const map = new Map(Object.entries(attrs));
  return {
    attrs: map,
    getAttribute: k => (map.has(k) ? map.get(k) : null),
    setAttribute: (k, v) => map.set(k, String(v)),
  };
}

/** A parsed document stub holding `links`. */
function doc(links, { url = EMAIL_URL, baseURI = url, readyState = "interactive" } = {}) {
  return {
    URL: url,
    baseURI,
    readyState,
    querySelectorAll(selector) {
      assert.equal(selector, "a[href], area[href]");
      return links;
    },
  };
}

const { EmailLinks } = loadApp();

// --- retarget: links that should open in a new tab ------------------------

test("http and https links open in a new tab", () => {
  const links = [link({ href: "https://www.notboring.co/p/some-essay" }),
                 link({ href: "http://example.com/" })];
  assert.equal(EmailLinks.retarget(doc(links)), 2);
  for (const l of links) {
    assert.equal(l.getAttribute("target"), "_blank");
    assert.equal(l.getAttribute("rel"), "noopener noreferrer");
  }
});

test("an email's own target is overridden, whatever it was", () => {
  // _self / _top / _parent / named frames all fail inside a sandboxed iframe.
  const targets = ["_self", "_top", "_parent", "somewindow", "_blank"];
  const links = targets.map(target => link({ href: "https://example.com/", target }));
  EmailLinks.retarget(doc(links));
  for (const l of links) assert.equal(l.getAttribute("target"), "_blank");
});

test("existing rel tokens are kept and not duplicated", () => {
  const l = link({ href: "https://example.com/", rel: "nofollow  noopener" });
  EmailLinks.retarget(doc([l]));
  assert.equal(l.getAttribute("rel"), "nofollow noopener noreferrer");
});

test("relative links resolve against the email and open in a new tab", () => {
  const l = link({ href: "../other/page.html" });
  EmailLinks.retarget(doc([l]));
  assert.equal(l.getAttribute("target"), "_blank");
});

test("an email's <base href> decides where a bare fragment points", () => {
  // Clicking this in-frame would navigate to the publisher, not scroll.
  const l = link({ href: "#comments" });
  EmailLinks.retarget(doc([l], { baseURI: "https://www.notboring.co/p/some-essay" }));
  assert.equal(l.getAttribute("target"), "_blank");
});

test("scheme matching is case-insensitive, like the browser's", () => {
  const l = link({ href: "HTTPS://Example.com/Path" });
  EmailLinks.retarget(doc([l]));
  assert.equal(l.getAttribute("target"), "_blank");
});

// --- retarget: links that must stay in the frame --------------------------

test("in-page anchors stay in the frame so they keep scrolling", () => {
  const links = [link({ href: "#section-2" }),
                 link({ href: EMAIL_URL + "#top" }),
                 link({ href: "" })];                // the document itself
  assert.equal(EmailLinks.retarget(doc(links)), 0);
  for (const l of links) {
    assert.equal(l.getAttribute("target"), "_self");
    assert.equal(l.getAttribute("rel"), null, "rel left untouched");
  }
});

test("an in-page anchor the email marked _blank is pinned back to _self", () => {
  const l = link({ href: "#top", target: "_blank" });
  EmailLinks.retarget(doc([l]));
  assert.equal(l.getAttribute("target"), "_self");
});

test("non-web schemes never open a new tab, even when marked _blank", () => {
  // Popups escape the sandbox, so a javascript: link in a new tab would run
  // unsandboxed. These must stay in the (script-less) frame.
  const hrefs = ["javascript:alert(document.domain)",
                 "JavaScript:alert(1)",
                 " javascript:alert(1)",       // leading space is stripped by the parser
                 "java\tscript:alert(1)",      // so are tabs and newlines inside it
                 "data:text/html,<script>alert(1)</script>",
                 "vbscript:msgbox(1)",
                 "blob:https://example.com/uuid",
                 "mailto:hello@example.com",
                 "tel:+15550100"];
  const links = hrefs.map(href => link({ href, target: "_blank" }));
  assert.equal(EmailLinks.retarget(doc(links)), 0);
  for (const l of links) {
    assert.equal(l.getAttribute("target"), "_self", `opens a tab: ${l.getAttribute("href")}`);
  }
});

test("an unparseable href is pinned to _self rather than throwing", () => {
  const l = link({ href: "http://[not-a-host/", target: "_blank" });
  assert.equal(EmailLinks.retarget(doc([l])), 0);
  assert.equal(l.getAttribute("target"), "_self");
});

test("retargeting twice changes nothing further (idempotent)", () => {
  const links = [link({ href: "https://example.com/", rel: "nofollow" }), link({ href: "#x" })];
  EmailLinks.retarget(doc(links));
  const first = links.map(l => new Map(l.attrs));
  EmailLinks.retarget(doc(links));
  links.forEach((l, i) => assert.deepEqual(l.attrs, first[i]));
});

test("a document with no links is fine", () => {
  assert.equal(EmailLinks.retarget(doc([])), 0);
});

// --- whenParsed: timing ---------------------------------------------------

/** An iframe stub whose contentDocument tests can swap, with a `load` hook. */
function iframe() {
  const listeners = [];
  return {
    contentDocument: doc([], { url: "about:blank", readyState: "complete" }),
    addEventListener(type, fn, opts) {
      assert.equal(type, "load");
      assert.deepEqual(opts, { once: true });
      listeners.push(fn);
    },
    fireLoad: () => listeners.splice(0).forEach(fn => fn()),
  };
}

test("waits past the initial about:blank and a still-parsing document", () => {
  const { EmailLinks, step } = loadApp();
  const frame = iframe();
  const seen = [];
  EmailLinks.whenParsed(frame, d => seen.push(d));

  step();                                              // initial about:blank
  frame.contentDocument = doc([], { readyState: "loading" });
  step();                                              // navigation committed, parsing
  assert.equal(seen.length, 0);

  const parsed = doc([], { readyState: "interactive" });
  frame.contentDocument = parsed;
  step();
  assert.deepEqual(seen, [parsed], "runs as soon as parsing finishes, before load");
});

test("runs exactly once, even when load follows", () => {
  const { EmailLinks, step, frames } = loadApp();
  const frame = iframe();
  let calls = 0;
  EmailLinks.whenParsed(frame, () => calls++);

  frame.contentDocument = doc([]);
  step();
  frame.contentDocument = doc([], { readyState: "complete" });
  frame.fireLoad();
  step();
  assert.equal(calls, 1);
  assert.equal(frames.length, 0, "polling stopped");
});

test("load is the fallback when no animation frame ran (background tab)", () => {
  const { EmailLinks } = loadApp();
  const frame = iframe();
  let calls = 0;
  EmailLinks.whenParsed(frame, () => calls++);

  frame.contentDocument = doc([], { readyState: "complete" });
  frame.fireLoad();
  assert.equal(calls, 1);
});

test("polling stops after load even if the document is unreadable", () => {
  const { EmailLinks, step, frames } = loadApp();
  const frame = iframe();
  let calls = 0;
  EmailLinks.whenParsed(frame, () => calls++);

  frame.contentDocument = null;                        // e.g. cross-origin
  step();
  frame.fireLoad();
  step();
  assert.equal(calls, 0);
  assert.equal(frames.length, 0, "no rAF loop left running");
});

// --- the iframe sandbox ---------------------------------------------------

for (const rel of ["view.html", "templates/view.html"]) {
  test(`${rel}: sandbox allows new tabs but never scripts`, () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const m = html.match(/<iframe[^>]*id="email-frame"[^>]*\bsandbox="([^"]*)"/);
    assert.ok(m, "email iframe with a sandbox attribute");
    const tokens = new Set(m[1].split(/\s+/).filter(Boolean));
    assert.deepEqual([...tokens].sort(), [
      "allow-popups",                    // target=_blank works at all
      "allow-popups-to-escape-sandbox",  // publisher's page runs normally
      "allow-same-origin",               // app.js can reach the email's DOM
    ]);
    // allow-scripts + allow-same-origin would let an email lift its own sandbox.
    assert.ok(!tokens.has("allow-scripts"));
  });
}

test("view.html and its template stay identical", () => {
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, "view.html"), "utf8"),
               fs.readFileSync(path.join(REPO_ROOT, "templates/view.html"), "utf8"));
});
