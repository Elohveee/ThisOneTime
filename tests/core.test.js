/**
 * core.test.js: tests for format choice, safe names, library rules, and view logic.
 *
 * Run with: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignFolderSuffixes, safeFileName, safeName } from "../dist/filenames.js";
import { chooseFormat, defaultPreferences, moveFormat, normalizePreferences } from "../dist/formats.js";
import { createLibrary, mergeScan, recoverInterrupted, retryProblems, summarize } from "../dist/library.js";
import { getPrimaryAction } from "../dist/view.js";
import { makeRelease } from "./helpers.js";

test("chooseFormat uses the first offered format", () => {
  assert.deepEqual(chooseFormat(defaultPreferences(), new Set(["mp3-320", "flac"])), {
    key: "flac",
    usedFallback: false,
  });
});

test("chooseFormat falls back in preference order", () => {
  assert.deepEqual(chooseFormat(defaultPreferences(), new Set(["vorbis", "mp3-v0"])), {
    key: "mp3-v0",
    usedFallback: true,
  });
});

test("chooseFormat ignores disabled formats and can return null", () => {
  const preferences = defaultPreferences().map((item) => ({ ...item, enabled: item.key === "wav" }));
  assert.equal(chooseFormat(preferences, new Set(["flac"])), null);
  assert.deepEqual(chooseFormat(preferences, new Set(["flac", "wav"])), { key: "wav", usedFallback: false });
});

test("a disabled higher format does not count as a fallback", () => {
  const preferences = defaultPreferences().map((item) => ({ ...item, enabled: item.key !== "flac" }));
  assert.equal(chooseFormat(preferences, new Set(["alac"])).usedFallback, false);
});

test("moveFormat reorders and stops at the edges", () => {
  const preferences = defaultPreferences();
  assert.equal(moveFormat(preferences, "alac", -1)[0].key, "alac");
  assert.deepEqual(moveFormat(preferences, "flac", -1), preferences);
  assert.equal(preferences[0].key, "flac");
});

test("normalizePreferences repairs saved lists", () => {
  const result = normalizePreferences([
    { key: "wav", enabled: false },
    { key: "wav", enabled: true },
    { key: "mystery", enabled: true },
  ]);
  assert.equal(result.length, 8);
  assert.deepEqual(result[0], { key: "wav", enabled: false });
  assert.equal(new Set(result.map((item) => item.key)).size, 8);
});

test("safeName neutralizes unsafe paths and reserved names", () => {
  for (const [input, expected] of [
    ["../..", "Unknown"],
    ["a/b:c", "a b c"],
    ["CON", "CON_"],
    [null, "Unknown"],
    ["  .name. ", "name"],
  ]) {
    assert.equal(safeName(input), expected);
  }
});

test("safeFileName keeps extensions within the byte limit", () => {
  const name = safeFileName(`${"é".repeat(300)}.FLAC`);
  assert.ok(name.endsWith(".flac"));
  assert.ok(Buffer.byteLength(name) <= 200);
});

test("same-named releases get separate folders without moving finished ones", () => {
  const done = makeRelease("a1", { title: "Same", status: "done" });
  const next = makeRelease("a2", { title: "same" });
  assignFolderSuffixes([next, done]);
  assert.equal(done.folderSuffix, "");
  assert.equal(next.folderSuffix, " [a2]");
});

test("mergeScan keeps finished work, adds new purchases, and drops stale pending items", () => {
  const library = createLibrary(1);
  library.phase = "finished";
  library.releases = [
    makeRelease("a1", { status: "done", format: "flac" }),
    makeRelease("a2", { status: "failed", note: "download_failed", redownloadUrl: "https://bandcamp.com/old" }),
    makeRelease("a3"),
    makeRelease("a9", { status: "done" }),
  ];
  mergeScan(library, [
    makeRelease("a1"),
    makeRelease("a2", { redownloadUrl: "https://bandcamp.com/new" }),
    makeRelease("a4"),
  ]);

  const byKey = new Map(library.releases.map((release) => [release.key, release]));
  assert.equal(byKey.get("a1").status, "done");
  assert.equal(byKey.get("a2").status, "failed");
  assert.equal(byKey.get("a2").redownloadUrl, "https://bandcamp.com/new");
  assert.equal(byKey.has("a3"), false);
  assert.equal(byKey.get("a4").status, "pending");
  assert.equal(byKey.get("a9").status, "done");
  assert.equal(library.phase, "idle");
});

test("a pre-order becomes pending once Bandcamp releases it", () => {
  const library = createLibrary(1);
  library.releases = [makeRelease("a1", { status: "preorder" })];
  mergeScan(library, [makeRelease("a1")]);
  assert.equal(library.releases[0].status, "pending");
});

test("recoverInterrupted returns active releases to the queue", () => {
  const library = createLibrary(1);
  library.phase = "running";
  library.releases = [makeRelease("a1", { status: "active" }), makeRelease("a2", { status: "done" })];
  assert.equal(recoverInterrupted(library), true);
  assert.deepEqual(library.releases.map((release) => release.status), ["pending", "done"]);
  assert.deepEqual([library.phase, library.pauseReason], ["paused", "tab_closed"]);
  assert.equal(recoverInterrupted(library), false);
});

test("retryProblems requeues only releases with problems", () => {
  const library = createLibrary(1);
  library.releases = [
    makeRelease("a1", { status: "failed", attempts: 3, note: "download_failed" }),
    makeRelease("a2", { status: "attention", note: "needs_confirmation" }),
    makeRelease("a3", { status: "done", note: "kept_zip" }),
  ];
  retryProblems(library);
  assert.deepEqual(library.releases.map((release) => release.status), ["pending", "pending", "done"]);
  assert.equal(library.releases[0].attempts, 0);
  assert.equal(library.releases[2].note, "kept_zip");
});

test("summarize counts formats, fallbacks, and kept ZIPs", () => {
  const library = createLibrary(1);
  library.releases = [
    makeRelease("a1", { status: "done", format: "flac" }),
    makeRelease("a2", { status: "done", format: "mp3-320", usedFallback: true, note: "kept_zip" }),
    makeRelease("a3", { status: "preorder" }),
    makeRelease("a4"),
  ];
  const summary = summarize(library);
  assert.deepEqual(summary.byFormat, { flac: 1, "mp3-320": 1 });
  assert.deepEqual([summary.fallbacks, summary.keptZips, summary.finished, summary.downloadable], [1, 1, 2, 3]);
});

test("the primary action follows the app state", () => {
  const library = createLibrary(1);
  library.releases = [makeRelease("a1")];
  const base = {
    stage: "ready",
    settings: { formats: defaultPreferences(), autoUnzip: true, includeHidden: false },
    library,
    folder: {},
    folderAccess: "granted",
  };

  assert.equal(getPrimaryAction({ ...base, stage: "logged_out" }).id, "login");
  assert.equal(getPrimaryAction({ ...base, folder: null }).id, "choose-folder");
  assert.equal(getPrimaryAction({ ...base, folderAccess: "prompt" }).id, "reconnect");
  assert.equal(getPrimaryAction(base).label, "Download library");
  const disabled = defaultPreferences().map((item) => ({ ...item, enabled: false }));
  assert.equal(getPrimaryAction({ ...base, settings: { ...base.settings, formats: disabled } }).disabled, true);

  library.phase = "paused";
  assert.equal(getPrimaryAction(base).label, "Resume");
  library.phase = "running";
  assert.equal(getPrimaryAction(base).id, "pause");
  library.phase = "finished";
  library.releases[0].status = "failed";
  assert.equal(getPrimaryAction(base).id, "retry");
  library.releases[0].status = "done";
  assert.equal(getPrimaryAction(base).label, "Up to date");
});
