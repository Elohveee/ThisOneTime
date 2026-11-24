/**
 * view-releases.ts: draws the searchable, paginated release list.
 *
 * Purpose:  Turn the library, filter, search text, and page into visible rows.
 * Order:    Filter, then search, then paginate.
 * Safety:   Bandcamp text is inserted with `textContent`, never `innerHTML`.
 * Focus:    Rows are rebuilt on each draw, so keyboard focus is put back on the
 *           matching button afterward.
 */
import { FORMAT_LABELS } from "./formats.js";
import { paginate, type Page } from "./pagination.js";
import { ignoredSet, matchesSearch, rowActions, type RowAction } from "./release-actions.js";
import type { Activity, Release, ReleaseNote } from "./types.js";
import type { AppState, Elements, ReleaseFilter } from "./view.js";

const NOTE_TEXT: Record<ReleaseNote, string> = {
  no_preferred_format: "No preferred format",
  needs_confirmation: "Needs confirmation",
  kept_zip: "Kept as ZIP",
  download_failed: "Failed",
};

/** Describes one release's current state. */
function metaText(release: Release, ignored: boolean, activity?: Activity): string {
  if (activity?.stage === "downloading" && activity.total > 0) {
    return `Downloading ${Math.floor((activity.done / activity.total) * 100)}%`;
  }
  if (activity?.stage === "unzipping") return `Unzipping ${activity.done + 1} of ${activity.total}`;
  if (activity) return "Preparing";
  if (ignored) return "Ignored";
  if (release.note) return NOTE_TEXT[release.note];
  if (release.redownload && release.status === "pending") return "Queued to redownload";
  if (release.status === "done") {
    const format = release.format ? FORMAT_LABELS[release.format] : "Saved";
    const label = release.usedFallback ? `${format} (fallback)` : format;
    return release.missingFromScan ? `${label} · Not in latest scan` : label;
  }
  const labels = { pending: "Queued", active: "Active", preorder: "Pre-order", unavailable: "Not downloadable" };
  return labels[release.status as keyof typeof labels] ?? release.status;
}

/** Applies the selected status filter. */
function matchesFilter(release: Release, filter: ReleaseFilter, ignored: boolean): boolean {
  if (filter === "ignored") return ignored;
  if (filter === "active") return release.status === "active";
  if (filter === "attention") {
    return !ignored && (["attention", "failed"].includes(release.status) || release.note === "kept_zip");
  }
  return true;
}

/** Returns the page of releases currently on screen. */
export function releasePage(state: AppState): Page<Release> {
  const library = state.library;
  const ignored = library ? ignoredSet(library) : new Set<string>();
  const matches = (library?.releases ?? []).filter(
    (release) =>
      matchesFilter(release, state.filter, ignored.has(release.key)) &&
      matchesSearch(release, state.search),
  );
  return paginate(matches, state.page);
}

/** Row buttons stay off while releases are changing underneath them. */
function rowsLocked(state: AppState): boolean {
  return (
    state.stage !== "ready" ||
    state.library?.phase === "running" ||
    Boolean(state.library?.releases.some((release) => release.status === "active"))
  );
}

/** Builds one row button. */
function actionButton(action: RowAction, release: Release): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-action";
  button.textContent = action.label;
  button.disabled = action.disabled;
  button.dataset.action = action.id;
  button.dataset.key = release.key;
  button.setAttribute("aria-label", `${action.label}: ${release.artist} — ${release.title}`);
  if (action.reason) button.title = action.reason;
  return button;
}

/** Builds one release row. */
function releaseRow(release: Release, state: AppState, ignored: boolean, locked: boolean): HTMLLIElement {
  const row = document.createElement("li");
  row.className = ignored ? "release ignored" : "release";
  row.dataset.key = release.key;

  const name = document.createElement("span");
  name.className = "release-name";
  name.textContent = `${release.artist} — ${release.title}`;
  name.title = name.textContent;

  const meta = document.createElement("span");
  meta.className = `release-meta ${ignored ? "ignored" : release.status}`;
  if (!ignored && release.note === "needs_confirmation" && release.redownloadUrl) {
    const link = document.createElement("a");
    link.href = release.redownloadUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = NOTE_TEXT.needs_confirmation;
    meta.append(link);
  } else {
    meta.textContent = metaText(release, ignored, state.activity.get(release.key));
  }

  const actions = document.createElement("span");
  actions.className = "release-actions";
  actions.append(...rowActions(release, ignored, locked).map((action) => actionButton(action, release)));

  const side = document.createElement("span");
  side.className = "release-side";
  side.append(meta, actions);
  row.append(name, side);
  return row;
}

/** Remembers which row button has keyboard focus before a redraw. */
function readFocus(el: Elements): { key: string; action: string; index: number } | null {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest<HTMLElement>(".release");
  if (!active?.dataset.action || !row || !el.releases.contains(row)) return null;
  const index = [...el.releases.children].indexOf(row);
  return { key: row.dataset.key ?? "", action: active.dataset.action, index };
}

/** Puts focus on the same action, or the nearest sensible control. */
function restoreFocus(el: Elements, saved: ReturnType<typeof readFocus>, locked: boolean): void {
  if (!saved || locked) return;
  const enabled = (root: Element | null | undefined) =>
    [...(root?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  const rows = [...el.releases.children] as HTMLElement[];
  const sameRow = rows.find((row) => row.dataset.key === saved.key);
  const target = sameRow
    ? (enabled(sameRow).find((button) => button.dataset.action === saved.action) ?? enabled(sameRow)[0])
    : enabled(rows[saved.index] ?? rows.at(-1))[0];
  (target ?? el.search).focus();
}

/** Sets text only when it changes, so screen readers are not re-notified. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Explains the list when a search is active or nothing is showing. */
function listNoteText(state: AppState, total: number): string {
  const query = state.search.trim();
  if (query && !total) return `No releases match "${query}".`;
  if (query) return `${total} ${total === 1 ? "match" : "matches"}`;
  if (total || !state.library?.releases.length) return "";
  return state.filter === "ignored" ? "No ignored releases." : "No releases to show.";
}

/** Draws the current page, its controls, and the list note. */
export function renderReleases(el: Elements, state: AppState): void {
  const focus = readFocus(el);
  const page = releasePage(state);
  const locked = rowsLocked(state);
  const ignored = state.library ? ignoredSet(state.library) : new Set<string>();

  el.releases.replaceChildren(
    ...page.items.map((release) => releaseRow(release, state, ignored.has(release.key), locked)),
  );
  restoreFocus(el, focus, locked);

  el.pager.hidden = page.pageCount <= 1;
  el.pagePrevious.disabled = page.page <= 1;
  el.pageNext.disabled = page.page >= page.pageCount;
  setText(el.pageText, `Page ${page.page} of ${page.pageCount} · Showing ${page.first}–${page.last} of ${page.total}`);

  const note = listNoteText(state, page.total);
  setText(el.listNote, note);
  el.listNote.hidden = !note;
}
