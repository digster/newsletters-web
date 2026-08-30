/**
 * Tests for the one-time localStorage key migration in app.js.
 *
 * Node's built-in test runner and assert — no npm packages, matching the
 * repo's no-dependency constraint. app.js is a browser IIFE, so it is loaded
 * here with a stubbed localStorage and the module's public API captured.
 *
 * Run with:
 *     node --test scripts/
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Load app.js against a fresh in-memory localStorage. */
function loadApp(initial = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const src = fs.readFileSync(path.join(REPO_ROOT, "app.js"), "utf8") + "\nreturn App;";
  // KeyMigration.run() fires during this call — that is the behaviour under test.
  const App = new Function("localStorage", "document", "window", src)(
    localStorage, undefined, { matchMedia: () => ({ matches: false }) });
  return { App, store };
}

const OLD = "emails/Not Boring/1a2b3c4d/1a2b3c4d5e6f7890.html";
const NEW = "emails/Not Boring/1a2b3c4d5e6f7890/1a2b3c4d5e6f7890.html";

// --- the rewrite rule -----------------------------------------------------

test("truncated directory is replaced by the full id from the filename", () => {
  const { App } = loadApp();
  assert.equal(App.KeyMigration.rewrite(OLD), NEW);
});

test("newsletter names containing spaces survive", () => {
  const { App } = loadApp();
  assert.equal(
    App.KeyMigration.rewrite("emails/Tyler Cowen/1953e3be/1953e3be34f4d721.html"),
    "emails/Tyler Cowen/1953e3be34f4d721/1953e3be34f4d721.html");
});

test("an already-migrated key is untouched (idempotent)", () => {
  const { App } = loadApp();
  assert.equal(App.KeyMigration.rewrite(NEW), NEW);
});

test("colliding ids migrate to distinct keys", () => {
  // The pair that shared a directory under the truncated scheme.
  const { App } = loadApp();
  const a = App.KeyMigration.rewrite("emails/Tyler Cowen/1953e3be/1953e3be34f4d721.html");
  const b = App.KeyMigration.rewrite("emails/Tyler Cowen/1953e3be/1953e3bed494d90c.html");
  assert.notEqual(a, b);
});

test("unrecognised shapes pass through unchanged", () => {
  const { App } = loadApp();
  for (const junk of ["", "nl_theme", "emails/x.html", "emails/A/b/c/d.html",
                      "emails/A/abcd1234/other.html",   // dir is not a prefix of stem
                      "emails/A/abc/abcd.txt",          // not .html
                      "http://example.com/y.html"]) {
    assert.equal(App.KeyMigration.rewrite(junk), junk, `mangled: ${junk}`);
  }
});

test("non-string input is returned as-is", () => {
  const { App } = loadApp();
  for (const v of [null, undefined, 42, {}]) {
    assert.equal(App.KeyMigration.rewrite(v), v);
  }
});

// --- run() ----------------------------------------------------------------

test("read and bookmark sets are both migrated, and the flag is set", () => {
  const { App, store } = loadApp({
    nl_read: JSON.stringify([OLD]),
    nl_bookmarks: JSON.stringify([OLD]),
  });
  assert.deepEqual(JSON.parse(store.get("nl_read")), [NEW]);
  assert.deepEqual(JSON.parse(store.get("nl_bookmarks")), [NEW]);
  assert.equal(store.get(App.KeyMigration.FLAG), App.KeyMigration.VERSION);
});

test("state is readable through Store after migration", () => {
  // The end-to-end point of the migration: a mark made under the old key must
  // still be found under the new one.
  const { App, store } = loadApp({ nl_bookmarks: JSON.stringify([OLD]) });
  assert.deepEqual(JSON.parse(store.get("nl_bookmarks")), [NEW]);
});

test("a second load does not rewrite already-migrated state", () => {
  const { App, store } = loadApp({ nl_read: JSON.stringify([OLD]) });
  const afterFirst = store.get("nl_read");
  // Re-run against the resulting storage.
  const { store: store2 } = loadApp(Object.fromEntries(store));
  assert.equal(store2.get("nl_read"), afterFirst);
});

test("the flag short-circuits the migration entirely", () => {
  const { store } = loadApp({
    nl_key_schema: "2",
    nl_read: JSON.stringify([OLD]),   // stale-looking, but must be left alone
  });
  assert.deepEqual(JSON.parse(store.get("nl_read")), [OLD]);
});

test("two old keys mapping to one new key are collapsed", () => {
  const { store } = loadApp({ nl_read: JSON.stringify([OLD, OLD, NEW]) });
  assert.deepEqual(JSON.parse(store.get("nl_read")), [NEW]);
});

test("absent keys are skipped without creating them", () => {
  const { App, store } = loadApp({});
  assert.equal(store.has("nl_read"), false);
  assert.equal(store.has("nl_bookmarks"), false);
  assert.equal(store.get(App.KeyMigration.FLAG), App.KeyMigration.VERSION);
});

test("corrupt JSON is left alone rather than destroyed", () => {
  const { store } = loadApp({ nl_read: "{not json", nl_bookmarks: JSON.stringify([OLD]) });
  assert.equal(store.get("nl_read"), "{not json");
  // The other key still migrates.
  assert.deepEqual(JSON.parse(store.get("nl_bookmarks")), [NEW]);
});

test("a non-array value is left alone", () => {
  const { store } = loadApp({ nl_read: JSON.stringify({ a: 1 }) });
  assert.deepEqual(JSON.parse(store.get("nl_read")), { a: 1 });
});

test("unavailable localStorage does not throw at load", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "app.js"), "utf8") + "\nreturn App;";
  const hostile = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.doesNotThrow(() => new Function("localStorage", "document", "window", src)(
    hostile, undefined, { matchMedia: () => ({ matches: false }) }));
});

test("the flag is not set when migration fails midway", () => {
  // Storage that accepts reads but rejects the write: the flag must stay unset
  // so the next load retries instead of leaving state half-migrated.
  const store = new Map([["nl_read", JSON.stringify([OLD])]]);
  const hostile = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem: k => store.delete(k),
  };
  const src = fs.readFileSync(path.join(REPO_ROOT, "app.js"), "utf8") + "\nreturn App;";
  const App = new Function("localStorage", "document", "window", src)(
    hostile, undefined, { matchMedia: () => ({ matches: false }) });
  assert.equal(store.has(App.KeyMigration.FLAG), false);
});

// --- against the real manifest -------------------------------------------

test("every live manifest key is stable under the migration", () => {
  // A rebuilt manifest must already be in its final form: if the rule altered
  // any current key, the migration would corrupt fresh state.
  const { App } = loadApp();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "data/index.json"), "utf8"));
  const altered = manifest.emails
    .map(e => e.file)
    .filter(f => App.KeyMigration.rewrite(f) !== f);
  assert.deepEqual(altered, []);
});
