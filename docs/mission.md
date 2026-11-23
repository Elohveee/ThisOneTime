# Mission Brief: Library Download View

**Category:** `Feature` | **Status:** `Approved, not yet implemented` | **Product:** `ThisOneTime`

---

## 1. Objective & Context

| Field | Details |
| :--- | :--- |
| **Mission Goal** | Let a logged-in Bandcamp fan back up their whole purchased library in a chosen format with one click. |
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
- **Choose:** Pick one format: FLAC (default), MP3 320, MP3 V0, AAC, Ogg Vorbis, ALAC, WAV, or AIFF.
- **Download:** One **Download library** button runs the queue with 3 concurrent downloads (adjustable 1 to 5).
- **Control:** Pause, Resume, and Retry failed.
- **Resume:** Progress survives closing the tab or restarting Chrome. Files already recorded in that format are skipped.
- **Save:** Files go to `Bandcamp/<Artist>/<Artist> - <Title>.<ext>` inside the browser's Downloads folder. Albums stay as Bandcamp's ZIP files.
- **Summarize:** Finish with counts and a list of anything that needs attention.

### Edge cases

| Case | Behavior |
| :--- | :--- |
| Subscription, physical-only, or no redownload URL | Listed as `Not downloadable`, never fails the run |
| Pre-order | Listed as `Pre-order`, picked up on a later run once available |
| Requested format missing | Marked `Format unavailable`. Never silently substitutes another format |
| HTTP 429 | Honor `Retry-After`, otherwise wait 10 s. Maximum 5 attempts |
| **Bandcamp client challenge** | **Pause the queue and ask the user to open Bandcamp and continue normally. Never solve, bypass, or spoof it** |
| Expired link needing email confirmation | Mark `Needs confirmation` with a link to the item. The user completes it |
| HTML or empty file returned instead of music | Cancel or remove that download and mark it failed |
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
| Controls | Format select, hidden-items checkbox, primary action |
| Progress | Overall bar, then `done / total` and active items |
| Results | Compact list filtered by All, Active, Needs attention |
| Colors | `--at-bg-main`, `--at-bg-surface`, `--at-text-main`, `--at-text-muted`, `--at-accent`, `--at-border` |
| Shape | `8px` radius, `1px` borders, `14px` base font |

| State | Primary action | Behavior |
| :--- | :--- | :--- |
| Logged out | Log in to Bandcamp | Opens Bandcamp |
| Scanning | Disabled | Live item count |
| Ready | Download library | Shows item count |
| Running | Pause | Progress updates, announced politely to screen readers |
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
                                    ├─ downloads.ts  wraps chrome.downloads
                                    ├─ storage.ts    saves progress
                                    └─ filenames.ts  builds safe paths
```

**Key decision: the work runs in an extension tab, not the service worker.** Service workers stop when idle and have no `DOMParser`. A pinned-open tab avoids both problems, so the worker is only a few lines.

### Proposed repository

```text
manifest.json
src/background.ts     Opens or focuses the app tab
src/app.html          Page markup
src/app.css           Tokens and styles
src/app.ts            Renders state, handles clicks
src/bandcamp.ts       Fan, collection, and file lookups
src/queue.ts          Concurrency, pause, retry
src/downloads.ts      Promise wrapper around chrome.downloads
src/storage.ts        Typed chrome.storage.local access
src/filenames.ts      Pure path helpers
src/types.ts          Shared interfaces
tests/                Unit tests with synthetic fixtures
docs/mission.md       This brief
docs/how-it-works.md  Plain-language walkthrough
```

### Bandcamp flow (undocumented, confirm in Spike S1)

1. `GET https://bandcamp.com/`, read `#HomepageApp[data-blob]` for `pageContext.identity`.
2. `POST /api/fancollection/1/collection_items` with `fan_id`, `count: 100`, and `older_than_token`. Stop on an empty page, `more_available: false`, or a repeated token.
3. Join each item to `redownload_urls` using `sale_item_type + sale_item_id`.
4. Just before downloading, fetch the redownload page, read `#pagedata[data-blob]`, match `digital_items[].item_id`, and take `downloads[format].url`.
5. Use the `statdownload` check only if Spike S1 proves it is required. Bandsnatch downloads without it.
6. Pass the final URL to `chrome.downloads.download`.

### Permissions

`downloads`, `storage`, and host access to `https://bandcamp.com/*`, `https://*.bandcamp.com/*`, and `https://*.bcbits.com/*`. No `cookies`, `tabs`, `scripting`, or content scripts.

### Code standards

- **Stack:** Strict TypeScript compiled with `tsc`. No bundler and **zero runtime dependencies**. pnpm for dev tools.
- **Size budget:** About 800 lines of code, excluding comments and tests. No source file over 200.
- **Comments:** Every file opens with a structured header covering purpose, inputs and outputs, interactions, and failure modes. Every exported function has TSDoc. Every Bandcamp quirk gets a comment explaining **why** and naming the assumption.
- **Isolation:** Only `bandcamp.ts` knows Bandcamp's data shapes, so a site change has one place to fix.
- **Parsing:** Validate untrusted JSON before use. Render with `textContent`, never `innerHTML`.
- **Privacy:** No analytics, crash reporting, remote code, or external servers. Signed URLs are never logged.
- **Public repo safety:** Fixtures are hand-written. Never commit real account data, cookies, or signed URLs.

### UI approach

For one screen, a UI framework would add more code than it removes. The interface uses native HTML and CSS with semantic `--at-*` color tokens.

### Spikes before feature work

| ID | Question | Pass condition |
| :--- | :--- | :--- |
| S1 | Does the flow work from an extension page with the user's session? | Reads the fan, a collection page, and one real file URL |
| S2 | Does Chrome honor the target filename and suppress save prompts? | One album and one track land in the right path unattended |
| S3 | Does a long run stay healthy? | 50 items at 3 concurrent, with pause, tab close, and resume |

---

## 5. Definition of Done

- [ ] **Code Quality:** Strict TypeScript, no `any`, no hardcoded colors outside the token definitions.
- [ ] **Simplicity:** Meets the size budget with zero runtime dependencies.
- [ ] **Documentation:** Every file and export is commented to the standard above.
- [ ] **Tests:** Parsing, pagination, queue, and filenames covered with synthetic fixtures.
- [ ] **Theming:** Verified in Light and Dark.
- [ ] **Accessibility:** Keyboard navigable, labeled controls, progress announced.
- [ ] **Real run:** A real library completes, and resume skips finished items.
- [ ] **Security:** Permissions match this brief. No secrets or personal data in git history.
- [ ] **Policy gate:** Bandcamp's Acceptable Use Policy reviewed before any store listing.
- [ ] **Agent Verification:** Screenshots and terminal output recorded.

---

## 6. Development Notes

- **Terms:** The Terms of Use (effective 2026-05-07) limit content to personal, non-commercial use and encourage fans to download purchases. The linked Acceptable Use Policy has not been reviewed, and the last third of the Terms was only read through a summary.
- **Fragility:** The flow relies on undocumented endpoints and can break without notice.
- **Known limit:** Chrome cannot inspect arbitrary files on disk, so "already downloaded" means recorded by ThisOneTime.
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
| F-03 | Spikes S1 to S3 | `○` | Gate for all feature work |

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

### Interface

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| U-01 | Single-page states | `○` | |
| U-02 | Progress and results list | `○` | |
| U-03 | Light, Dark, and accessibility pass | `○` | |

### Deferred

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| D-01 | Automatic unzip | `✗` | Would need a dependency |
| D-02 | Cover art, filename templates | `✗` | Bandcamp ZIPs generally suffice for v1 |
| D-03 | Firefox support | `✗` | After Chrome is stable |
| D-04 | Scheduled background sync | `✗` | Conflicts with the simple tab model |
