# Mission Brief: Library Download View

**Category:** `Feature` | **Status:** `Approved, not yet implemented` | **Product:** `ThisOneTime`

---

## 1. Objective & Context

| Field | Details |
| :--- | :--- |
| **Mission Goal** | Let a logged-in Bandcamp fan back up their whole purchased library in their best available format, ready to play, with one click. |
| **User Story** | As a Bandcamp fan, I want to download everything I own and safely resume later so that my music stays with me if a release disappears. |
| **Why build it** | Batchcamp already does this well. ThisOneTime's reason to exist is a small, heavily commented, telemetry-free codebase that anyone can read in one sitting. |

**References:** [Bandcamp Terms of Use](https://bandcamp.com/terms_of_use)

### 1.1 Audit of existing tools (2026-11-22)

| Tool | Type | License | Last push | Take | Avoid |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [Batchcamp](https://github.com/hyphmongo/batchcamp) | MV3 extension, TypeScript | MIT | 2026-09 | Extension-tab runner, `autoDiscardable: false`, expired-link detection | DOM injection on Bandcamp pages, Sentry and analytics, broad UI surface |
| [bandcampsync](https://github.com/meeb/bandcampsync) | Python CLI | BSD-3 | 2026-11 | Pagination stop rules, per-item matching, HTML-response and expiry checks | Browser fingerprint impersonation to get past client challenges |
| [bandsnatch](https://github.com/Ovyerus/bandsnatch) | Rust CLI | MIT | 2026-11 | Login detection from homepage, 3 req/s limit, 429 retry, filtering undownloadable items | Exported cookies |
| [bandcamp-downloader](https://github.com/easlice/bandcamp-downloader) | Python CLI | MIT | 2025-08 | Hidden-item support, format-to-extension map, end-of-run summary | Exported cookies, single 29 KB file |
| [bandcamp-dl](https://github.com/iliana/bandcamp-dl) | Python script | MIT-0 | 2024-04 | Clearest minimal flow (about 280 lines) | Assumes one digital item per page |
| [bandcamp-collection-downloader](https://github.com/Ezwen/bandcamp-collection-downloader) | Kotlin CLI | AGPL-3.0 | 2024-10 | Concept only | **Do not copy code**, its license would bind this project |

**Conclusions:**

1. All tools share one four-step flow: identify the fan, page the collection, read each download page, fetch the file.
2. Most complexity in the CLIs is cookie handling and anti-bot workarounds. A browser extension needs neither.
3. Most complexity in Batchcamp is injected page UI and telemetry. A single extension page removes both.

---

## 2. Functional Requirements

- **Connect:** Clicking the toolbar icon opens the ThisOneTime tab, which detects the logged-in fan. If logged out, it shows a link to Bandcamp's login page. ThisOneTime never reads, stores, or asks for credentials or cookies.
- **Scan:** Load the full collection with a live count. Hidden items are included only when the user opts in.
- **Format preferences:** A saved, ordered list decides the format. For each release, ThisOneTime downloads **exactly one** format: the first enabled format in the list that Bandcamp offers for that release.
- **Default order:** FLAC, ALAC, WAV, AIFF, MP3 320, MP3 V0, AAC, Ogg Vorbis. Users can reorder formats and disable any they never want.
- **Choose folder:** The user picks a backup folder, such as `Music/Bandcamp`. Browser rules restrict the top-level Downloads and Documents folders, so the UI suggests a subfolder.
- **Auto-unzip:** On by default. Albums are extracted to `<Artist>/<Title>/`, ready to play or upload. When off, albums stay as `<Artist>/<Artist> - <Title>.zip`.
- **Download:** One **Download library** button runs the queue with 3 concurrent downloads (adjustable 1 to 5). One album extracts at a time to limit disk load.
- **Control:** Pause, Resume, and Retry failed.
- **Resume:** Progress survives closing the tab or restarting Chrome. A release counts as finished once it is saved and verified, whichever format it used. Changing preferences later does not re-download it.
- **Save:** Single tracks go to `<Artist>/<Title>/<Track>.<ext>`, so albums and singles share one predictable layout.
- **Summarize:** Finish with counts per format, releases that used a fallback format, and anything that needs attention.

### Edge cases

| Case | Behavior |
| :--- | :--- |
| Subscription, physical-only, or no redownload URL | Listed as `Not downloadable`, never fails the run |
| Pre-order | Listed as `Pre-order`, picked up on a later run once available |
| First-choice format missing | Use the next enabled format and show which one was used |
| No enabled format available | Marked `No preferred format`, listing what Bandcamp offers. Nothing is downloaded |
| All formats disabled | Download button disabled with an inline explanation |
| Folder permission lost after restart | Pause. **Resume** asks Chrome to restore access to the same folder |
| Disk full | Pause, remove that item's temporary file, and show `Disk full` |
| ZIP damaged or checksum mismatch | Discard partial output and retry the download. After retries, mark it failed |
| ZIP uses an unsupported feature (for example ZIP64 or encryption) | Keep the original ZIP, mark `Kept as ZIP`, and count it as saved |
| ZIP entry has an unsafe path (`../`, absolute path) | Refuse the extraction and keep the ZIP. Never write outside the release folder |
| Files moved or deleted after backup | Still counts as finished, so uploading then clearing local copies does not trigger re-downloads |
| HTTP 429 | Honor `Retry-After`, otherwise wait 10 s. Maximum 5 attempts |
| **Bandcamp client challenge** | **Pause the queue and ask the user to open Bandcamp and continue normally. Never solve, bypass, or spoof it** |
| Expired link needing email confirmation | Detect it only when the file request returns HTML, then mark `Needs confirmation` with a link to the item. The user completes it. Never trust the page's `.email-reauth-error` element alone |
| Sale type looks physical (`p`) | Do not skip by sale type. Use the redownload URL and download page to decide |
| HTML or empty file returned instead of music | Stop before saving it and mark it failed |
| Same artist and title twice | Append the item ID to the filename |
| Illegal filename characters, long names | Sanitized and truncated in one tested function |
| Session expires mid-run | Pause and ask the user to log in, then resume |

---

## 3. Visual & Logic Specifications

One screen, one primary action. No popup, options page, or injected Bandcamp UI.

| Property | Value / Behavior |
| :--- | :--- |
| Layout | Centered column, `720px` max width, `16px` gap |
| Header | Name, logged-in fan, theme follows the system |
| Controls | Backup folder, format preferences, auto-unzip switch, hidden-items checkbox, primary action |
| Format preferences | Ordered rows with rank, enable checkbox, and Move up / Move down buttons. No drag-only interaction |
| Progress | Overall bar, then `done / total` and active items |
| Results | Compact list filtered by All, Active, Needs attention |
| Colors | `--at-bg-main`, `--at-bg-surface`, `--at-text-main`, `--at-text-muted`, `--at-accent`, `--at-border` |
| Shape | `8px` radius, `1px` borders, `14px` base font |

| State | Primary action | Behavior |
| :--- | :--- | :--- |
| Logged out | Log in to Bandcamp | Opens Bandcamp |
| Scanning | Disabled | Live item count |
| No folder | Choose backup folder | Opens the folder picker |
| Ready | Download library | Shows item count |
| Running | Pause | Shows downloading or unzipping per item, announced politely to screen readers |
| Paused | Resume | Shows the reason |
| Finished | Retry failed, if any | Summary |
| Transitions | | Color shifts `150ms ease-in-out` |

---

## 4. Technical Constraints

### Architecture

```text
Toolbar click → background.ts → opens app.html
                                    │
                                    ├─ bandcamp.ts   talks to Bandcamp
                                    ├─ queue.ts      decides what runs next
                                    ├─ formats.ts    picks the best format
                                    ├─ files.ts      streams to the chosen folder
                                    ├─ zip.ts        extracts and verifies albums
                                    ├─ storage.ts    saves settings and progress
                                    └─ filenames.ts  builds safe paths
```

**Key decision: the work runs in an extension tab, not the service worker.** Service workers stop when idle and have no `DOMParser`. A pinned-open tab avoids both problems, so the worker is only a few lines.

**Key decision: write through the File System Access API instead of `chrome.downloads`.** Chrome's downloads API cannot read a finished file back, so it cannot unzip it. Writing to a user-chosen folder gives one save path for albums and tracks, removes the `downloads` permission, and adds byte-level progress. If Spike S4 fails, the fallback is `chrome.downloads` with albums kept as ZIPs.

### Format selection

`chooseFormat(preferences, availableFormats)` is a small pure function. It returns the first enabled preference that exists in the release's `downloads` object, or `null`. Bandcamp keys confirmed by Spike S1: `flac`, `alac`, `wav`, `aiff-lossless`, `mp3-320`, `mp3-v0`, `aac-hi`, `vorbis`.

### Auto-unzip pipeline

1. Stream the ZIP to a temporary file in `<backup folder>/.thisonetime-tmp/`.
2. Read the ZIP's central directory from the end of the file and validate every entry path.
3. Extract each entry. Stored entries copy directly, and Deflate entries use Chrome's native `DecompressionStream("deflate-raw")`.
4. Check each file's size and CRC-32 against the ZIP.
5. Mark the release finished, then delete the temporary ZIP. **The ZIP is never deleted before every file verifies.**

Extraction temporarily needs about twice the album's size in free disk space.

### Proposed repository

```text
manifest.json
src/background.ts     Opens or focuses the app tab
src/app.html          Page markup
src/app.css           Tokens and styles
src/app.ts            Renders state, handles clicks
src/bandcamp.ts       Fan, collection, and file lookups
src/queue.ts          Concurrency, pause, retry
src/formats.ts        Format list, defaults, and chooseFormat
src/files.ts          Folder access and streaming writes
src/zip.ts            Dependency-free ZIP reader and verifier
src/storage.ts        Typed settings, progress, and folder handle storage
src/filenames.ts      Pure path helpers
src/types.ts          Shared interfaces
tests/                Unit tests with synthetic fixtures
docs/mission.md       This brief
docs/how-it-works.md  Plain-language walkthrough
```

### Bandcamp flow (undocumented, confirmed by Spike S1 on 2026-11-22)

1. `GET https://bandcamp.com/`, read `#HomepageApp[data-blob]` for `pageContext.identity`.
2. `POST /api/fancollection/1/collection_items` with `fan_id`, `count: 100`, and `older_than_token`. Stop on an empty page, `more_available: false`, or a repeated token.
3. Join each item to `redownload_urls` using `sale_item_type + sale_item_id`.
4. Just before downloading, fetch the redownload page, read `#pagedata[data-blob]`, match `digital_items[].item_id`, run `chooseFormat`, and take that format's URL.
5. Do not call `statdownload` by default. S1 reached the file directly. Add it only if real runs show direct links failing.
6. Stream the final URL with `fetch` into the chosen folder.

### Permissions

`storage` and host access to `https://bandcamp.com/*`, `https://*.bandcamp.com/*`, and `https://*.bcbits.com/*`. Folder access is granted by the user through Chrome's picker. No `downloads`, `cookies`, `tabs`, `scripting`, or content scripts.

### Code standards

- **Stack:** Strict TypeScript compiled with `tsc`. No bundler and **zero runtime dependencies**. pnpm for dev tools.
- **Size budget:** About 1,100 lines of code, excluding comments and tests. No source file over 200.
- **Comments:** Every file opens with a structured header covering purpose, inputs and outputs, interactions, and failure modes. Every exported function has TSDoc. Every Bandcamp quirk gets a comment explaining **why** and naming the assumption.
- **Isolation:** Only `bandcamp.ts` knows Bandcamp's data shapes, so a site change has one place to fix.
- **Parsing:** Validate untrusted JSON before use. Render with `textContent`, never `innerHTML`.
- **Privacy:** No analytics, crash reporting, remote code, or external servers. Signed URLs are never logged. Bandcamp's page data includes payment and gift fields, so `bandcamp.ts` copies only an explicit allowlist of fields and never stores or logs raw blobs.
- **Public repo safety:** Fixtures are hand-written. Never commit real account data, cookies, or signed URLs.

### UI approach

For one screen, a UI framework would add more code than it removes. The interface uses native HTML and CSS with semantic `--at-*` color tokens.

### Spikes before feature work

| ID | Question | Pass condition |
| :--- | :--- | :--- |
| S1 ✓ | Does the flow work from an extension page with the user's session? | **Passed 2026-11-22.** Read the fan, two collection pages with no overlap, and the first bytes of one real ZIP |
| S2 | Can an extension page stream Bandcamp files into a chosen folder? | One album and one track save unattended at the right paths |
| S3 | Does a long run stay healthy? | 50 items at 3 concurrent, with pause, tab close, and resume |
| S4 | Does folder access survive a browser restart? | The saved handle resumes with at most one Chrome permission prompt |
| S5 | Do real Bandcamp ZIPs extract correctly? | Real albums pass CRC-32, including a large lossless album, and play normally |

---

## 5. Definition of Done

- [ ] **Code Quality:** Strict TypeScript, no `any`, no hardcoded colors outside the token definitions.
- [ ] **Simplicity:** Meets the size budget with zero runtime dependencies.
- [ ] **Documentation:** Every file and export is commented to the standard above.
- [ ] **Tests:** Parsing, pagination, queue, format fallback, ZIP extraction, unsafe ZIP paths, and filenames covered with synthetic fixtures.
- [ ] **Theming:** Verified in Light and Dark.
- [ ] **Accessibility:** Keyboard navigable, labeled controls, progress announced.
- [ ] **Real run:** A real library completes, fallback formats work, unzipped albums play, and resume skips finished items.
- [ ] **Security:** Permissions match this brief. No secrets or personal data in git history.
- [ ] **Policy gate:** Bandcamp's Acceptable Use Policy reviewed before any store listing.
- [ ] **Agent Verification:** Screenshots and terminal output recorded.

---

## 6. Development Notes

- **Terms:** The Terms of Use (effective 2026-05-07) limit content to personal, non-commercial use and encourage fans to download purchases. The linked Acceptable Use Policy has not been reviewed, and the last third of the Terms was only read through a summary.
- **Fragility:** The flow relies on undocumented endpoints and can break without notice.
- **Known limit:** "Already downloaded" means recorded by ThisOneTime, so files added to the folder by other tools are not detected.
- **S1 findings:** One real account and one file were tested. All 8 formats were offered, the file host returned `206` for a byte-range request, and the page's email-confirmation check gave a false positive on a working download. Byte-range resume could later avoid restarting interrupted files, but v1 keeps the simpler restart.
- **Tab must stay open:** Downloading and unzipping run in the extension tab. Closing it pauses the run, and any in-progress item restarts on resume.
- **Folder access:** Chrome documents the picker's restricted folders, but persistence across restarts from an extension page is unverified until Spike S4.
- **Naming:** ThisOneTime nods to the "this one time, at band camp" line from *American Pie*. The product is not affiliated with Bandcamp or the film.

---

## 7. Implementation Tracker

### Status Legend

| Symbol | Meaning |
| :--- | :--- |
| `✓` | Implemented and verified |
| `○` | Specified, not yet started |
| `◐` | Partially implemented |
| `✗` | Intentionally deferred or descoped |

### Foundation

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| F-01 | Public repository, MIT license, README | `✓` | |
| F-02 | MV3 manifest, TypeScript build, tests | `○` | |
| F-03 | Spikes S1 to S5 | `◐` | S1 passed. S2 to S5 still gate feature work |

### Library

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| L-01 | Login detection | `○` | |
| L-02 | Collection scan and pagination | `○` | |
| L-03 | Hidden items opt-in | `○` | |
| L-04 | Download-page lookup | `○` | |

### Queue

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| Q-01 | Concurrent queue, pause, resume | `○` | |
| Q-02 | Persistent progress | `○` | |
| Q-03 | Rate limit and retry handling | `○` | |
| Q-04 | Challenge, expiry, and bad-file handling | `○` | Never bypass a challenge |
| Q-05 | Safe filenames | `○` | |

### Format Preferences

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| P-01 | Saved ordered format list | `○` | |
| P-02 | Reorder and enable controls | `○` | Keyboard accessible |
| P-03 | `chooseFormat` fallback | `○` | Exactly one format per release |
| P-04 | Fallback reporting | `○` | |

### Files & Unzip

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| Z-01 | Backup folder picker and saved access | `○` | Depends on S4 |
| Z-02 | Streaming file writer | `○` | |
| Z-03 | ZIP reader with path validation | `○` | No dependencies |
| Z-04 | CRC-32 verification | `○` | |
| Z-05 | Auto-unzip setting | `○` | On by default |
| Z-06 | Temporary file cleanup | `○` | ZIP removed only after verification |

### Interface

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| U-01 | Single-page states | `○` | |
| U-02 | Progress and results list | `○` | |
| U-03 | Light, Dark, and accessibility pass | `○` | |

### Deferred

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| D-01 | ZIP64 extraction | `✗` | Oversized albums are kept as ZIPs in v1 |
| D-02 | Cover art, filename templates | `✗` | Bandcamp ZIPs generally suffice for v1 |
| D-03 | Firefox support | `✗` | Needs a different folder-writing approach |
| D-04 | Scheduled background sync | `✗` | Conflicts with the simple tab model |
| D-05 | Direct upload to remote storage | `✗` | v1 writes to a folder that backup tools can watch |
