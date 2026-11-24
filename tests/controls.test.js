/**
 * controls.test.js: tests for ignore, search, pagination, and redownload.
 *
 * Run with: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBandcampClient } from "../dist/bandcamp.js";
import { defaultPreferences } from "../dist/formats.js";
import { createLibrary, mergeScan, recoverInterrupted, retryProblems, summarize } from "../dist/library.js";
import { paginate } from "../dist/pagination.js";
import { createQueue } from "../dist/queue.js";
import {
  cancelRedownload,
  matchesSearch,
  queueRedownload,
  rowActions,
  setIgnored,
} from "../dist/release-actions.js";
import { getPrimaryAction } from "../dist/view.js";
import { fakeBandcamp, makeRelease, MemoryFolder, noWait, parseHtml } from "./helpers.js";

const libraryWith = (...releases) => ({ ...createLibrary(1), releases });
const done = (key, overrides = {}) => makeRelease(key, { status: "done", format: "flac", ...overrides });
const ids = (actions) => actions.map((action) => action.id);

/** Backs up a fake library, returning tools for a second run. */
async function backedUp(options = {}, settingOverrides = {}) {
  const server = fakeBandcamp(options);
  const client = createBandcampClient({ fetchImpl: server.fetch, parseHtml, wait: noWait });
  const settings = { formats: defaultPreferences(), autoUnzip: true, includeHidden: false, ...settingOverrides };
  const library = createLibrary(42);
  mergeScan(library, await client.scanLibrary(42, false, () => undefined));
  const root = new MemoryFolder();
  const run = () =>
    createQueue({ client, root, library, settings, save: async () => undefined, onChange: () => undefined, wait: noWait }).start();
  await run();
  return { server, client, settings, library, root, run };
}

const fileText = async (root, path) => {
  const parts = path.split("/");
  const name = parts.pop();
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part);
  return (await (await folder.getFileHandle(name)).getFile()).text();
};

test("search is a trimmed, case-insensitive match across artist and title", () => {
  const release = makeRelease("a1", { artist: "Radiohead", title: "Kid A" });
  for (const query of ["", "  kid a ", "RADIOHEAD", "radiohead kid"]) assert.equal(matchesSearch(release, query), true);
  assert.equal(matchesSearch(release, "amnesiac"), false);
});

test("pagination reports ranges and clamps out-of-range pages", () => {
  const items = Array.from({ length: 120 }, (_, index) => index + 1);
  const second = paginate(items, 2);
  assert.deepEqual([second.items[0], second.items.at(-1), second.first, second.last, second.pageCount], [51, 100, 51, 100, 3]);
  assert.deepEqual([paginate(items, 99).page, paginate(items, 99).last], [3, 120]);
  assert.equal(paginate(items, 0).page, 1);
  assert.deepEqual([paginate([], 4).page, paginate([], 4).first, paginate([], 4).last], [1, 0, 0]);
});

test("ignored releases leave totals and return to their earlier state", () => {
  const library = libraryWith(done("a1"), makeRelease("a2"));
  setIgnored(library, library.releases[0], true);
  setIgnored(library, library.releases[1], true);
  let summary = summarize(library);
  assert.deepEqual([summary.ignored, summary.downloadable, summary.counts.pending], [2, 0, 0]);

  setIgnored(library, library.releases[0], false);
  setIgnored(library, library.releases[1], false);
  summary = summarize(library);
  assert.deepEqual([summary.ignored, summary.counts.done, summary.counts.pending], [0, 1, 1]);
});

test("ignore survives a release leaving and returning to a scan", () => {
  const library = libraryWith(makeRelease("a1"));
  setIgnored(library, library.releases[0], true);
  mergeScan(library, []);
  assert.equal(library.releases.length, 0);
  mergeScan(library, [makeRelease("a1")]);
  assert.equal(summarize(library).ignored, 1);
});

test("retry skips ignored releases", () => {
  const library = libraryWith(makeRelease("a1", { status: "failed" }), makeRelease("a2", { status: "failed" }));
  setIgnored(library, library.releases[0], true);
  retryProblems(library);
  assert.deepEqual(library.releases.map((release) => release.status), ["failed", "pending"]);
});

test("the queue never downloads ignored releases", async () => {
  const server = fakeBandcamp({ count: 3 });
  const client = createBandcampClient({ fetchImpl: server.fetch, parseHtml, wait: noWait });
  const library = createLibrary(42);
  mergeScan(library, await client.scanLibrary(42, false, () => undefined));
  setIgnored(library, library.releases[1], true);
  const settings = { formats: defaultPreferences(), autoUnzip: true, includeHidden: false };
  await createQueue({ client, root: new MemoryFolder(), library, settings, save: async () => undefined, onChange: () => undefined, wait: noWait }).start();
  assert.deepEqual(library.releases.map((release) => release.status), ["done", "pending", "done"]);
  assert.equal(server.fileRequests.has(2), false);
  assert.equal(library.phase, "finished");
});

test("ignoring everything left in a paused queue finishes it", () => {
  const library = libraryWith(done("a1"), makeRelease("a2"));
  library.phase = "paused";
  library.pauseReason = "user";
  setIgnored(library, library.releases[1], true);
  assert.deepEqual([library.phase, library.pauseReason], ["finished", null]);
  setIgnored(library, library.releases[1], false);
  assert.equal(library.phase, "idle");
});

test("row actions follow the release state", () => {
  assert.deepEqual(ids(rowActions(done("a1"), false, false)), ["redownload", "ignore"]);
  assert.deepEqual(ids(rowActions(makeRelease("a1"), false, false)), ["ignore"]);
  assert.deepEqual(ids(rowActions(done("a1"), true, false)), ["unignore"]);
  const queued = makeRelease("a1", { redownload: { note: null } });
  assert.deepEqual(ids(rowActions(queued, false, false)), ["cancel-redownload", "ignore"]);
  assert.ok(rowActions(done("a1"), false, true).every((action) => action.disabled));
  const missing = rowActions(done("a1", { missingFromScan: true }), false, false)[0];
  assert.equal(missing.disabled, true);
  assert.ok(missing.reason);
});

test("cancel restores a finished release exactly", () => {
  const release = done("a1", { note: "kept_zip", usedFallback: true });
  const library = libraryWith(release);
  library.phase = "finished";
  queueRedownload(library, release);
  assert.deepEqual([release.status, release.note, library.phase], ["pending", null, "idle"]);
  cancelRedownload(library, release);
  assert.deepEqual([release.status, release.note, release.format, release.usedFallback], ["done", "kept_zip", "flac", true]);
  assert.equal("redownload" in release, false);
});

test("ignoring a queued redownload cancels it", () => {
  const release = done("a1");
  const library = libraryWith(release);
  queueRedownload(library, release);
  setIgnored(library, release, true);
  assert.equal(release.status, "done");
  assert.equal(release.redownload, undefined);
});

test("scans refresh finished links but keep the saved names", () => {
  const library = libraryWith(done("a1", { title: "Old Name", redownloadUrl: "https://bandcamp.com/old" }));
  mergeScan(library, [makeRelease("a1", { title: "New Name", redownloadUrl: "https://bandcamp.com/new" })]);
  assert.deepEqual([library.releases[0].title, library.releases[0].redownloadUrl], ["Old Name", "https://bandcamp.com/new"]);
});

test("finished releases that leave a scan cannot be redownloaded", () => {
  const library = libraryWith(done("a1"));
  mergeScan(library, []);
  assert.equal(library.releases[0].missingFromScan, true);
  queueRedownload(library, library.releases[0]);
  assert.equal(library.releases[0].status, "done");
  mergeScan(library, [makeRelease("a1")]);
  assert.equal(library.releases[0].missingFromScan, false);
});

test("a queued redownload that leaves the scan keeps its finished record", () => {
  const library = libraryWith(done("a1"));
  queueRedownload(library, library.releases[0]);
  mergeScan(library, []);
  assert.deepEqual([library.releases.length, library.releases[0].status], [1, "done"]);
});

test("a tab closed during a redownload keeps its finished record", () => {
  const release = done("a1", { note: "kept_zip" });
  const library = libraryWith(release);
  queueRedownload(library, release);
  release.status = "active";
  library.phase = "running";
  recoverInterrupted(library);
  mergeScan(library, [makeRelease("a1")]);
  assert.equal(library.releases[0].status, "pending");
  cancelRedownload(library, library.releases[0]);
  assert.deepEqual([library.releases[0].status, library.releases[0].note], ["done", "kept_zip"]);
});

test("the primary button names queued redownloads", () => {
  const library = libraryWith(done("a1"), done("a2"), done("a3"));
  queueRedownload(library, library.releases[0]);
  queueRedownload(library, library.releases[1]);
  const state = {
    stage: "ready",
    settings: { formats: defaultPreferences(), autoUnzip: true, includeHidden: false },
    library,
    folder: {},
    folderAccess: "granted",
  };
  assert.equal(getPrimaryAction(state).label, "Redownload 2");
});

test("a redownload replaces only the chosen release, in the current format", async () => {
  const { library, root, server, settings, run } = await backedUp({ count: 3 });
  const paths = root.paths().length;
  settings.formats = defaultPreferences().map((format) => ({ ...format, enabled: format.key === "mp3-320" }));
  queueRedownload(library, library.releases[1]);
  await run();
  assert.equal(library.releases[1].status, "done");
  assert.equal(library.releases[1].format, "mp3-320");
  assert.equal(library.releases[1].redownload, undefined);
  assert.equal(library.releases[0].format, "flac");
  assert.deepEqual([server.fileRequests.get(1), server.fileRequests.get(2), server.fileRequests.get(3)], [1, 2, 1]);
  assert.equal(root.paths().length, paths);
});

test("a failed redownload never removes existing files and can be canceled", async () => {
  const { library, root, server, run } = await backedUp({ count: 1 });
  const before = root.paths().sort();
  const cover = await fileText(root, "Test Artist/Album 1/cover.jpg");
  server.damagedAfterFirst = 1;
  queueRedownload(library, library.releases[0]);
  await run();

  assert.equal(library.releases[0].status, "failed");
  assert.deepEqual(root.paths().sort(), before);
  assert.equal(await fileText(root, "Test Artist/Album 1/cover.jpg"), cover);
  assert.ok((await fileText(root, "Test Artist/Album 1/01 Song 1.flac")).length > 0);

  cancelRedownload(library, library.releases[0]);
  assert.deepEqual([library.releases[0].status, library.releases[0].note, library.releases[0].format], ["done", null, "flac"]);
});

test("a failed new track leaves no empty file", async () => {
  const { library, root } = await backedUp({ count: 1, trackId: 1, truncated: 1 });
  assert.equal(library.releases[0].status, "failed");
  assert.deepEqual(root.paths(), []);
});

test("a cut-off redownload keeps the existing track", async () => {
  const { library, root, server, run } = await backedUp({ count: 1, trackId: 1 });
  server.truncated = 1;
  queueRedownload(library, library.releases[0]);
  await run();
  assert.equal(library.releases[0].status, "failed");
  assert.equal(await fileText(root, "Test Artist/Album 1/Album 1.flac"), "track-1");
});
