# Mission Brief: Library Controls

**ID:** `TOT-02` | **Category:** `Feature` | **Status:** `Built, awaiting a real album redownload` | **Product:** `ThisOneTime`

---

## 1. Objective & Context

| Field | Details |
| :--- | :--- |
| **Mission Goal** | Let users browse and find any release, leave chosen releases out of backups, and download specific releases again. |
| **User Story** | As a Bandcamp collector, I want to control individual releases so that my backup contains what I want and I can replace a lost or damaged copy. |

**References:**
- Original brief: [mission.md](mission.md)
- Code tour: [how-it-works.md](how-it-works.md)

---

## 2. Functional Requirements

### Ignore

- **Mark:** Each release row has an **Ignore** action. Ignored rows stay visible, muted, and labeled `Ignored`.
- **Effect:** Ignored releases are never downloaded or retried, and do not count toward progress or status totals.
- **Files:** Ignoring never deletes or moves anything on disk.
- **Restore:** **Stop ignoring** returns the release to its earlier state. A finished release stays finished and is not downloaded again. An unfinished release rejoins the queue.
- **Persistence:** The choice survives reloads, rescans, Chrome restarts, and toggling hidden items.
- **Filter:** A new **Ignored** filter shows only ignored releases.

### Search

- **Input:** A search box above the release list filters as you type.
- **Match:** A trimmed, case-insensitive substring of `<artist> <title>`. `kid a` and `radiohead kid` both match *Radiohead, Kid A*.
- **Combines:** Search applies on top of the selected filter.
- **Scope:** Search covers the whole library and runs before pagination.
- **Feedback:** The list shows the match count, and a clear message when nothing matches.
- **Persistence:** Search text is not saved between visits.

### Pagination

- **Replaces the limit:** Pages replace the current 200-row display limit, so every release can be reached.
- **Page size:** A fixed 50 releases per page.
- **Controls:** **Previous** and **Next** buttons with `Page 2 of 19` and `Showing 51–100 of 945`. Controls are hidden when everything fits on one page.
- **Order:** Filter, then search, then paginate. Release order does not change.
- **Reset:** Changing the search text or filter returns to page 1.
- **Stable during changes:** Download progress and row actions keep the current page. If the list shrinks, the page moves back to the last valid one.
- **Persistence:** The current page is not saved between visits.

### Redownload

- **Queue:** Finished releases have a **Redownload** action. Users can queue several, then start them with the main button, labeled `Redownload 3`.
- **Cancel:** A queued or failed redownload has **Cancel**, which restores its earlier finished state.
- **Format:** Uses the current format preferences, so it can also upgrade or change a release's format.
- **Location:** Saves to the current backup folder at the release's usual path.
- **Safety:** An existing good copy is never removed because a redownload failed or was paused.
- **Different format:** Old files in another format are left in place. ThisOneTime never deletes files it did not write during the current attempt.
- **Unavailable:** Redownload is disabled, with an explanation, when a release is missing from the latest scan. Its saved link may no longer work.

### Edge cases

| Case | Behavior |
| :--- | :--- |
| Queue is running | Row actions are disabled. Pause first |
| Queue is paused | Row actions work, then **Resume** continues |
| Ignoring a queued redownload | The redownload is canceled and the release stays finished |
| Redownload fails | Shown under Needs attention. **Retry failed** or **Cancel** both work |
| Tab closes during a redownload | Returns to the queue, and its finished record is preserved |
| Latest scan failed | Saved links are used. An expired link shows `Needs confirmation` |
| Existing saved library | Loads without migration steps. Missing new fields mean "not ignored" and "not redownloading" |

---

## 3. Visual & Logic Specifications

### Layout

| Property | Value / Behavior |
| :--- | :--- |
| Search | Full-width `type="search"` input between the Releases heading and list, labeled `Search releases` |
| Filters | All, Active, Needs attention, Ignored |
| Pagination | Below the list: Previous, page and range text, Next. The range text is announced politely to screen readers |
| Row | Name, status, then one or two compact text buttons |
| Ignored row | Muted using existing `--at-*` tokens, without relying on color alone |
| Narrow screens | Row actions wrap below the name |

### Row actions

| Release state | Actions |
| :--- | :--- |
| Done | Redownload, Ignore |
| Queued for redownload, or failed redownload | Cancel, Ignore |
| Pending, attention, failed, pre-order, or unavailable | Ignore |
| Ignored | Stop ignoring |
| Any row while running | Disabled |

---

## 4. Technical Constraints

### Data model

```ts
interface Library {
  // ...existing fields
  /** Release keys the user chose to leave out. */
  ignoredKeys?: string[];
}

interface Release {
  // ...existing fields
  /** Present while replacing a finished copy. Holds the earlier note. */
  redownload?: { note: ReleaseNote | null };
  /** A finished release that was absent from the latest scan. */
  missingFromScan?: boolean;
}
```

- **Ignored keys live on the library,** not the release, so `mergeScan` cannot lose them when a release leaves and later returns to a scan.
- **`redownload` stores the earlier note, and `format` and `usedFallback` stay until success,** which makes Cancel an exact restore.

### Required fixes found during planning

1. **Protect existing files.** `extractAlbum` in `files.ts` removes every file it wrote when an attempt fails. On a redownload those can be the user's good copies. It must record which files already existed and clean up only the newly created ones.
2. **Refresh links on finished releases.** `mergeScan` in `library.ts` keeps the old signed link for done releases. It must take the fresh link while keeping the saved artist and title, so a redownload lands in the same folder even if the release was renamed.
3. **Protect redownload records.** `mergeScan` drops unfinished releases missing from a scan. Releases with `redownload` must be kept like finished ones.

### Code changes

| File | Change |
| :--- | :--- |
| `src/release-actions.ts` (new) | Pure rules: ignore, restore, queue, cancel, eligibility, search match |
| `src/pagination.ts` (new) | Pure page calculation with clamping |
| `src/types.ts` | New optional fields |
| `src/library.ts` | Scan fixes. `summarize` and `retryProblems` skip ignored releases |
| `src/queue.ts` | Workers skip ignored releases. Success clears `redownload` |
| `src/files.ts` | Existing-file protection |
| `src/view.ts`, `src/view-lists.ts` | Search, Ignored filter, pagination, row actions, button label |
| `src/app.ts`, `src/dom.ts`, `src/app.html`, `src/app.css` | Wiring, search input, styles |
| `tests/` | Coverage for every rule and edge case above |
| `README.md`, `docs/how-it-works.md` | Document the new controls |

### Standards

- No new dependencies or permissions.
- Bandcamp text is rendered with `textContent`.
- Keep files under 200 code lines with detailed comments.
- Keyboard focus stays on the matching row after an action redraws the list.

---

## 5. Definition of Done

- [x] **Code Quality:** Strict TypeScript, no `any`, no hardcoded colors.
- [x] **Tests:** Ignore, search, pagination, redownload, cancel, scan merging, and failed-redownload file safety are covered.
- [x] **Data Safety:** A failed or paused redownload leaves every existing file readable.
- [x] **Compatibility:** A library saved by v1 loads with all progress intact.
- [x] **Theming:** Verified in Light and Dark.
- [x] **Accessibility:** New controls have clear names and work by keyboard.
- [x] **Agent Verification:** Run in a real browser against a simulated Bandcamp.
- [ ] **Real Run:** One real album redownloaded, verified, and played.

---

## 6. Development Notes

- **Verification:** 59 automated tests pass. The built interface ran in a real browser against a simulated 120-release Bandcamp, covering pagination, search, ignore across a reload, the running lock, redownload, cancel, a corrupted redownload, narrow screens, and both themes.
- **Not yet verified:** A redownload against the real Bandcamp site, and a full screen reader pass.
- **Extra fix:** A failed write to a new file used to leave an empty file behind in Chrome. New files are now removed on failure.
- **Known limit:** If a file passes its write check but then fails the read-back check, that replaced file is already on disk. The release is retried and flagged if it keeps failing.
- **Temporary files:** Canceling a paused redownload can leave a temporary ZIP in `.thisonetime-tmp` until the next completed run.

---

## 7. Implementation Tracker

| Symbol | Meaning |
| :--- | :--- |
| `✓` | Implemented and verified |
| `○` | Specified, not yet started |
| `◐` | Partially implemented |
| `✗` | Intentionally deferred or descoped |

### Foundation

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| C-01 | Data model and pure action rules | `✓` | |
| C-02 | Protect existing files on failure | `✓` | Must land before redownload |
| C-03 | Scan merge fixes | `✓` | |

### Ignore

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| I-01 | Ignore and restore | `✓` | |
| I-02 | Queue, retry, and totals skip ignored | `✓` | |
| I-03 | Ignored filter and row style | `✓` | |

### Search

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| S-01 | Search input and matching | `✓` | |
| S-02 | Match count and empty state | `✓` | |

### Pagination

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| P-01 | Pure page calculation and clamping | `✓` | |
| P-02 | Previous, Next, and range text | `✓` | Replaces the 200-row limit |
| P-03 | Reset on search or filter change | `✓` | |

### Redownload

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| R-01 | Queue and cancel | `✓` | |
| R-02 | Main button and status text | `✓` | |
| R-03 | Disabled state for missing releases | `✓` | |
| R-04 | Real album verification | `○` | Needs a redownload on the real site |

### Deferred

| ID | Feature | Status | Notes |
| :--- | :--- | :--- | :--- |
| X-01 | Multi-select and bulk actions | `✗` | Search plus row actions covers v1 of this feature |
| X-02 | Removing old files after a format change | `✗` | Deleting user files needs its own design |
| X-03 | Accent-insensitive search | `✗` | Basic string match was requested |
