/**
 * queue.test.js: end-to-end tests using a fake Bandcamp and in-memory folder.
 *
 * Run with: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBandcampClient } from "../dist/bandcamp.js";
import { defaultPreferences } from "../dist/formats.js";
import { createLibrary, mergeScan, recoverInterrupted, retryProblems } from "../dist/library.js";
import { createQueue } from "../dist/queue.js";
import { fakeBandcamp, MemoryFolder, noWait, parseHtml } from "./helpers.js";

/** Scans the fake library and prepares a queue. */
async function setup(serverOptions = {}, settingOverrides = {}) {
  const server = fakeBandcamp(serverOptions);
  const client = createBandcampClient({ fetchImpl: server.fetch, parseHtml, wait: noWait });
  const settings = { formats: defaultPreferences(), autoUnzip: true, includeHidden: false, ...settingOverrides };
  const fan = await client.getFan();
  const library = createLibrary(fan.fanId);
  mergeScan(library, await client.scanLibrary(fan.fanId, settings.includeHidden, () => undefined));
  const root = new MemoryFolder();
  const snapshots = [];
  const makeQueue = (target = library) =>
    createQueue({
      client,
      root,
      library: target,
      settings,
      save: async (state) => snapshots.push(structuredClone(state)),
      onChange: () => undefined,
      wait: noWait,
    });
  return { server, client, settings, library, root, snapshots, makeQueue };
}

const statuses = (library) => library.releases.map((release) => release.status);
const count = (library, status) => statuses(library).filter((item) => item === status).length;

async function until(condition) {
  for (let tick = 0; tick < 5000; tick += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out");
}

test("finds the fan and reports a logged-out session", async () => {
  const signedIn = createBandcampClient({ fetchImpl: fakeBandcamp().fetch, parseHtml, wait: noWait });
  assert.deepEqual(await signedIn.getFan(), { fanId: 42, username: "testfan" });
  const signedOut = createBandcampClient({ fetchImpl: fakeBandcamp({ loggedOut: true }).fetch, parseHtml, wait: noWait });
  assert.equal(await signedOut.getFan(), null);
});

test("scans every page and never stores private fields", async () => {
  const { library } = await setup({ count: 25, pageSize: 10 });
  assert.equal(library.releases.length, 25);
  assert.equal(JSON.stringify(library).includes("private@example.test"), false);
});

test("hidden items are included only when requested", async () => {
  const hidden = await setup({ count: 2 }, { includeHidden: true });
  assert.equal(hidden.library.releases.length, 3);
  assert.equal(hidden.library.releases.find((release) => release.key === "r100").hidden, true);
  const normal = await setup({ count: 2 });
  assert.equal(normal.library.releases.length, 2);
});

test("backs up albums unzipped and cleans temporary files", async () => {
  const { library, root, server, makeQueue } = await setup({ count: 7 });
  await makeQueue().start();
  assert.equal(library.phase, "finished");
  assert.equal(count(library, "done"), 7);
  assert.ok(server.peakFiles <= 3);
  assert.equal(root.paths().length, 14);
  assert.ok(root.paths().includes("Test Artist/Album 1/01 Song 1.flac"));
  assert.ok(!root.paths().some((path) => path.includes(".thisonetime-tmp") || path.endsWith(".zip")));
  assert.equal(library.releases[0].format, "flac");
});

test("keeps albums as ZIPs when auto-unzip is off", async () => {
  const { root, makeQueue } = await setup({ count: 2 }, { autoUnzip: false });
  await makeQueue().start();
  assert.deepEqual(root.paths().sort(), [
    "Test Artist/Test Artist - Album 1.zip",
    "Test Artist/Test Artist - Album 2.zip",
  ]);
});

test("saves single tracks in their own folder", async () => {
  const { root, library, makeQueue } = await setup({ count: 1, trackId: 1 });
  await makeQueue().start();
  assert.deepEqual(root.paths(), ["Test Artist/Album 1/Album 1.flac"]);
  assert.equal(library.releases[0].kind, "track");
});

test("uses and reports fallback formats", async () => {
  const { library, makeQueue } = await setup({ count: 1, onlyFormats: { 1: ["vorbis", "mp3-v0"] } });
  await makeQueue().start();
  assert.equal(library.releases[0].format, "mp3-v0");
  assert.equal(library.releases[0].usedFallback, true);
});

test("flags releases with no enabled format and downloads nothing", async () => {
  const preferences = defaultPreferences().map((item) => ({ ...item, enabled: item.key === "wav" }));
  const { library, server, makeQueue } = await setup({ count: 1 }, { formats: preferences });
  await makeQueue().start();
  assert.deepEqual([library.releases[0].status, library.releases[0].note], ["attention", "no_preferred_format"]);
  assert.equal(server.fileRequests.size, 0);
});

test("skips pre-orders and unavailable items", async () => {
  const { library, makeQueue } = await setup({ count: 3, preorder: 1, unavailable: 2 });
  await makeQueue().start();
  assert.deepEqual(statuses(library), ["preorder", "unavailable", "done"]);
});

test("pause and resume finish every release exactly once", async () => {
  const { library, root, server, makeQueue } = await setup({ count: 12, chunkDelay: 1 });
  const queue = makeQueue();
  const run = queue.start();
  await until(() => count(library, "done") >= 2 && count(library, "active") > 0);
  await queue.pause();
  await run;
  assert.deepEqual([library.phase, library.pauseReason, count(library, "active")], ["paused", "user", 0]);

  await makeQueue().start();
  assert.equal(count(library, "done"), 12);
  assert.equal(root.paths().length, 24);
  assert.ok(server.peakFiles <= 3);
});

test("recovers from a closed tab using the saved state", async () => {
  const { library, root, snapshots, makeQueue } = await setup({ count: 9, chunkDelay: 1 });
  const queue = makeQueue();
  const run = queue.start();
  await until(() => count(library, "done") >= 2 && count(library, "active") > 0);
  const saved = structuredClone(snapshots.filter((state) => state.phase === "running" && count(state, "active")).at(-1));
  await queue.pause();
  await run;

  assert.equal(recoverInterrupted(saved), true);
  assert.equal(count(saved, "active"), 0);
  await makeQueue(saved).start();
  assert.equal(count(saved, "done"), 9);
  assert.equal(root.paths().filter((path) => path.endsWith(".flac")).length, 9);
});

test("waits and retries after a brief rate limit", async () => {
  const { library, server, makeQueue } = await setup({ count: 3, rateLimited: 2 });
  await makeQueue().start();
  assert.equal(count(library, "done"), 3);
  assert.equal(server.fileRequests.get(2), 2);
});

test("a long rate limit pauses the queue and resumes cleanly", async () => {
  const { library, server, makeQueue } = await setup({ count: 4, rateLimitedForever: 2 });
  await makeQueue().start();
  assert.deepEqual([library.phase, library.pauseReason], ["paused", "rate_limited"]);
  assert.equal(count(library, "active"), 0);
  server.rateLimitedForever = undefined;
  await makeQueue().start();
  assert.equal(count(library, "done"), 4);
});

test("a security challenge pauses the queue", async () => {
  const { library, makeQueue } = await setup({ count: 3, challengeFile: 1 });
  await makeQueue().start();
  assert.deepEqual([library.phase, library.pauseReason], ["paused", "client_challenge"]);
});

test("retries a temporary failure", async () => {
  const { library, server, makeQueue } = await setup({ count: 2, flakyFile: 1 });
  await makeQueue().start();
  assert.equal(count(library, "done"), 2);
  assert.equal(server.fileRequests.get(1), 2);
});

test("a permanent failure stops after three attempts and can be retried", async () => {
  const { library, server, makeQueue } = await setup({ count: 3, brokenFile: 2 });
  await makeQueue().start();
  assert.equal(count(library, "failed"), 1);
  assert.equal(count(library, "done"), 2);
  assert.equal(server.fileRequests.get(2), 3);

  server.brokenFile = undefined;
  retryProblems(library);
  await makeQueue().start();
  assert.equal(count(library, "done"), 3);
});

test("an expired link is flagged without saving a web page", async () => {
  const { library, root, makeQueue } = await setup({ count: 1, expired: 1 });
  await makeQueue().start();
  assert.deepEqual([library.releases[0].status, library.releases[0].note], ["attention", "needs_confirmation"]);
  assert.equal(root.paths().length, 0);
});

test("a damaged ZIP is retried and leaves no partial files", async () => {
  const { library, root, server, makeQueue } = await setup({ count: 1, badCrc: 1 });
  await makeQueue().start();
  assert.equal(library.releases[0].status, "failed");
  assert.equal(server.fileRequests.get(1), 3);
  assert.equal(root.paths().length, 0);
});

test("an unsupported ZIP is kept and counted as saved", async () => {
  const { library, root, makeQueue } = await setup({ count: 1, nested: 1 });
  await makeQueue().start();
  assert.deepEqual([library.releases[0].status, library.releases[0].note], ["done", "kept_zip"]);
  assert.deepEqual(root.paths(), ["Test Artist/Test Artist - Album 1.zip"]);
});
