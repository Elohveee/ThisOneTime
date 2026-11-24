/**
 * helpers.js: synthetic test doubles.
 *
 * Purpose: Run the real extension modules in Node without Chrome or Bandcamp.
 * Privacy: All data here is invented. Never add real account data, cookies,
 *          signed URLs, or responses captured from Bandcamp.
 */
import { crc32, deflateRawSync } from "node:zlib";

/** An in-memory stand-in for FileSystemDirectoryHandle. */
export class MemoryFolder {
  name = "Test Folder";
  folders = new Map();
  files = new Map();

  async getDirectoryHandle(name, options = {}) {
    if (/[/\\]/.test(name) || name === "." || name === "..") throw new TypeError("bad name");
    if (!this.folders.has(name)) {
      if (!options.create) throw new DOMException("missing", "NotFoundError");
      this.folders.set(name, new MemoryFolder());
    }
    return this.folders.get(name);
  }

  async getFileHandle(name) {
    if (/[/\\]/.test(name)) throw new TypeError("bad name");
    const { files } = this;
    return {
      // Like Chrome, the destination changes only when the stream closes.
      async createWritable() {
        const chunks = [];
        return new WritableStream({
          write: (chunk) => chunks.push(chunk),
          close: () => files.set(name, new Blob(chunks)),
        });
      },
      getFile: async () => files.get(name),
    };
  }

  async removeEntry(name, options = {}) {
    if (this.files.delete(name)) return;
    const folder = this.folders.get(name);
    if (!folder) throw new DOMException("missing", "NotFoundError");
    if (!options.recursive && (folder.files.size || folder.folders.size)) {
      throw new DOMException("not empty", "InvalidModificationError");
    }
    this.folders.delete(name);
  }

  /** Lists every file path below this folder. */
  paths(prefix = "") {
    return [
      ...[...this.files.keys()].map((name) => `${prefix}${name}`),
      ...[...this.folders].flatMap(([name, child]) => child.paths(`${prefix}${name}/`)),
    ];
  }
}

/** Builds a real ZIP byte array with optional deliberate defects. */
export function makeZip(entries, { patchEnd } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const checksum = entry.crc ?? crc32(data);
    const flags = entry.flags ?? 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.declaredSize ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    central.push(record, name);
    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  patchEnd?.(end);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** Creates a minimal release for pure-function tests. */
export function makeRelease(key, overrides = {}) {
  return {
    key,
    itemId: key.slice(1),
    redownloadUrl: `https://bandcamp.com/download?id=${key}`,
    artist: "Test Artist",
    title: `Test Title ${key}`,
    kind: "album",
    hidden: false,
    status: "pending",
    note: null,
    format: null,
    usedFallback: false,
    attempts: 0,
    folderSuffix: "",
    ...overrides,
  };
}

const attribute = (value) => JSON.stringify(value).replaceAll('"', "&quot;");

/** A tiny DOMParser replacement that reads `data-blob` attributes. */
export const parseHtml = (html) => ({
  getElementById(id) {
    const match = html.match(new RegExp(`id="${id}" data-blob="([^"]*)"`));
    return match ? { getAttribute: () => match[1].replaceAll("&quot;", '"') } : null;
  },
});

/** A delay that resolves immediately, while still respecting abort signals. */
export const noWait = async (_ms, signal) => signal?.throwIfAborted();

/**
 * A fake Bandcamp server.
 *
 * Numeric options target a release ID, such as `flakyFile: 2`.
 */
export function fakeBandcamp(options = {}) {
  const server = { requests: [], fileRequests: new Map(), activeFiles: 0, peakFiles: 0, ...options };
  const count = server.count ?? 7;
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const pageSize = server.pageSize ?? count;

  const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });
  const fileBytes = (id) =>
    server.badCrc === id
      ? makeZip([{ name: "01.flac", data: "audio", crc: 1 }])
      : server.nested === id
        ? makeZip([{ name: "disc/01.flac", data: "audio" }])
        : makeZip([
            { name: `01 Song ${id}.flac`, data: `audio-${id}`.repeat(200) },
            { name: "cover.jpg", data: `art-${id}`, method: 8 },
          ]);

  server.fetch = async (url, init = {}) => {
    server.requests.push(url);
    init.signal?.throwIfAborted();

    if (url === "https://bandcamp.com/") {
      if (server.challenge) return response("Client Challenge _fs-ch-");
      const identity = server.loggedOut
        ? { isLoggedIn: false }
        : { isLoggedIn: true, fanId: 42, fanUsername: "testfan" };
      return response(`<div id="HomepageApp" data-blob="${attribute({ pageContext: { identity } })}"></div>`);
    }

    if (url.includes("/collection_items") || url.includes("/hidden_items")) {
      const hidden = url.includes("/hidden_items");
      const body = JSON.parse(init.body);
      const start = body.older_than_token.startsWith("page-") ? Number(body.older_than_token.slice(5)) : 0;
      const source = hidden ? [100] : ids;
      const pageIds = source.slice(start, start + pageSize);
      const more = start + pageSize < source.length;
      return response(
        JSON.stringify({
          items: pageIds.map((id) => ({
            sale_item_type: "r",
            sale_item_id: id,
            item_id: id,
            band_name: "Test Artist",
            item_title: `Album ${id}`,
            tralbum_type: server.trackId === id ? "t" : "a",
            is_preorder: server.preorder === id,
            download_available: server.unavailable === id ? false : true,
            payment_email: "private@example.test",
          })),
          more_available: more,
          last_token: `page-${start + pageSize}`,
          redownload_urls: Object.fromEntries(
            pageIds.map((id) => [`r${id}`, `https://bandcamp.com/download?id=${id}`]),
          ),
        }),
      );
    }

    const page = url.match(/download\?id=(\d+)/);
    if (page) {
      const id = Number(page[1]);
      const formats = server.onlyFormats?.[id] ?? ["mp3-320", "flac"];
      const downloads = Object.fromEntries(
        formats.map((key) => [key, { url: `https://p4.bcbits.com/file/${id}/${key}` }]),
      );
      const item = {
        item_id: id,
        artist: "Test Artist",
        title: `Album ${id}`,
        download_type: server.trackId === id ? "t" : "a",
        payment_email: "private@example.test",
        downloads,
      };
      return response(`<div id="pagedata" data-blob="${attribute({ digital_items: [item] })}"></div>`);
    }

    const file = url.match(/file\/(\d+)\//);
    if (file) {
      const id = Number(file[1]);
      const attempt = (server.fileRequests.get(id) ?? 0) + 1;
      server.fileRequests.set(id, attempt);
      if (server.rateLimited === id && attempt === 1) return response("slow", 429, { "retry-after": "1" });
      if (server.rateLimitedForever === id) return response("slow", 429, { "retry-after": "9999" });
      if (server.flakyFile === id && attempt === 1) return response("oops", 503);
      if (server.brokenFile === id) return response("oops", 503);
      if (server.expired === id) return response("<html>Confirm</html>", 200, { "content-type": "text/html" });
      if (server.challengeFile === id) {
        return response("Client Challenge _fs-ch-", 200, { "content-type": "text/html" });
      }

      const bytes = server.trackId === id ? new TextEncoder().encode(`track-${id}`) : fileBytes(id);
      server.activeFiles += 1;
      server.peakFiles = Math.max(server.peakFiles, server.activeFiles);
      let sent = 0;
      let open = true;
      const finish = () => {
        if (open) server.activeFiles -= 1;
        open = false;
      };
      const body = new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, server.chunkDelay ?? 0));
          if (init.signal?.aborted) {
            finish();
            controller.error(init.signal.reason);
            return;
          }
          if (sent >= bytes.length) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(sent, sent + 256));
          sent += 256;
        },
        cancel: finish,
      });
      return response(body, 200, {
        "content-type": server.trackId === id ? "audio/flac" : "application/zip",
        "content-length": String(bytes.length),
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return server;
}
