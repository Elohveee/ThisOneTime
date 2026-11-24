/**
 * zip.test.js: tests the ZIP reader with valid, damaged, and hostile archives.
 *
 * Run with: pnpm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { CRC_START, crc32Finish, crc32OfBlob, crc32Update } from "../dist/crc32.js";
import { extractEntry, readEntries, ZipError } from "../dist/zip.js";
import { makeZip, MemoryFolder } from "./helpers.js";

/** Asserts that a ZIP is refused with a specific failure code. */
async function assertRefused(bytes, code) {
  await assert.rejects(
    readEntries(new Blob([bytes])),
    (error) => error instanceof ZipError && error.code === code,
  );
}

test("CRC-32 matches Node's implementation across chunks", async () => {
  const data = Buffer.from("this one time, at band camp".repeat(100));
  const part = crc32Update(crc32Update(CRC_START, data.subarray(0, 17)), data.subarray(17));
  assert.equal(crc32Finish(part), crc32(data));
  assert.equal(await crc32OfBlob(new Blob([data])), crc32(data));
});

test("extracts stored, deflated, and empty entries", async () => {
  const song = Buffer.from("audio".repeat(5000));
  const zip = new Blob([
    makeZip([
      { name: "01 Song.flac", data: song },
      { name: "notes.txt", data: "hello ".repeat(500), method: 8 },
      { name: "empty.txt", data: "" },
    ]),
  ]);
  const folder = new MemoryFolder();
  const entries = await readEntries(zip);
  assert.equal(entries.length, 3);

  for (const entry of entries) {
    const handle = await folder.getFileHandle(entry.outputName, { create: true });
    await extractEntry(zip, entry, await handle.createWritable());
  }
  assert.deepEqual(Buffer.from(await folder.files.get("01 Song.flac").arrayBuffer()), song);
  assert.equal(await folder.files.get("notes.txt").text(), "hello ".repeat(500));
  assert.equal(folder.files.get("empty.txt").size, 0);
});

test("refuses unsafe and unsupported archives", async () => {
  const one = (name, extra = {}) => makeZip([{ name, data: "x", ...extra }]);
  await assertRefused(one("../evil.flac"), "unsafe_path");
  await assertRefused(one("/evil.flac"), "unsafe_path");
  await assertRefused(one("a\\evil.flac"), "unsafe_path");
  await assertRefused(one("C:evil.flac"), "unsafe_path");
  await assertRefused(one("disc/song.flac"), "nested_entry");
  await assertRefused(one("song.flac", { flags: 1 }), "encrypted");
  await assertRefused(
    makeZip([{ name: "A.flac", data: "x" }, { name: "a.flac", data: "y" }]),
    "duplicate_name",
  );
  await assertRefused(
    makeZip([{ name: "a.flac", data: "x" }], { patchEnd: (end) => end.writeUInt32LE(0xffffffff, 16) }),
    "zip64",
  );
  await assertRefused(new Uint8Array(100), "not_a_zip");
});

test("classifies refusals as keep and damage as retry", () => {
  assert.equal(new ZipError("zip64").shouldKeepZip, true);
  assert.equal(new ZipError("unsafe_path").shouldKeepZip, true);
  assert.equal(new ZipError("crc_mismatch").shouldKeepZip, false);
  assert.equal(new ZipError("corrupt_data").shouldKeepZip, false);
});

for (const [label, entry, code] of [
  ["CRC", { name: "a.flac", data: "hello", crc: 1 }, "crc_mismatch"],
  ["oversized output", { name: "a.flac", data: "hello world", method: 8, declaredSize: 3 }, "size_mismatch"],
]) {
  test(`a bad ${label} never commits an output file`, async () => {
    const zip = new Blob([makeZip([entry])]);
    const [parsed] = await readEntries(zip);
    const folder = new MemoryFolder();
    const handle = await folder.getFileHandle("a.flac", { create: true });
    await assert.rejects(
      extractEntry(zip, parsed, await handle.createWritable()),
      (error) => error.code === code,
    );
    // Only the empty file from opening the handle remains. No bad bytes landed.
    assert.equal(folder.files.get("a.flac").size, 0);
  });
}
