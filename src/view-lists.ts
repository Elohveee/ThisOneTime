/**
 * view-lists.ts: draws the release list and format preference rows.
 *
 * Purpose:  Keep repeated row rendering apart from the main view.
 * Safety:   Bandcamp text is inserted with `textContent`, never `innerHTML`.
 * Scale:    The list shows at most 200 rows, so large libraries stay responsive.
 */
import { FORMAT_LABELS } from "./formats.js";
import type { Activity, Release, ReleaseNote, Settings } from "./types.js";
import type { AppState, Elements, ReleaseFilter } from "./view.js";

const MAX_ROWS = 200;

const NOTE_TEXT: Record<ReleaseNote, string> = {
  no_preferred_format: "No preferred format",
  needs_confirmation: "Needs confirmation",
  kept_zip: "Kept as ZIP",
  download_failed: "Failed",
};

/** Describes one release's current state. */
function metaText(release: Release, activity?: Activity): string {
  if (activity?.stage === "downloading" && activity.total > 0) {
    return `Downloading ${Math.floor((activity.done / activity.total) * 100)}%`;
  }
  if (activity?.stage === "unzipping") return `Unzipping ${activity.done + 1} of ${activity.total}`;
  if (activity) return "Preparing";
  if (release.note) return NOTE_TEXT[release.note];
  if (release.status === "done") {
    const format = release.format ? FORMAT_LABELS[release.format] : "Saved";
    return release.usedFallback ? `${format} (fallback)` : format;
  }
  const labels = { pending: "Queued", active: "Active", preorder: "Pre-order", unavailable: "Not downloadable" };
  return labels[release.status as keyof typeof labels] ?? release.status;
}

/** Applies the selected list filter. */
function matchesFilter(release: Release, filter: ReleaseFilter): boolean {
  if (filter === "active") return release.status === "active";
  if (filter === "attention") {
    return ["attention", "failed"].includes(release.status) || release.note === "kept_zip";
  }
  return true;
}

/** Draws the filtered release list. */
export function renderReleases(el: Elements, state: AppState): void {
  const matches = (state.library?.releases ?? []).filter((release) => matchesFilter(release, state.filter));
  const rows = matches.slice(0, MAX_ROWS).map((release) => {
    const row = document.createElement("li");
    row.className = "release";
    const name = document.createElement("span");
    name.className = "release-name";
    name.textContent = `${release.artist} — ${release.title}`;
    name.title = name.textContent;

    const meta = document.createElement("span");
    meta.className = `release-meta ${release.status}`;
    if (release.note === "needs_confirmation" && release.redownloadUrl) {
      const link = document.createElement("a");
      link.href = release.redownloadUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = NOTE_TEXT.needs_confirmation;
      meta.append(link);
    } else {
      meta.textContent = metaText(release, state.activity.get(release.key));
    }
    row.append(name, meta);
    return row;
  });
  el.releases.replaceChildren(...rows);
  el.listNote.hidden = matches.length <= MAX_ROWS;
  el.listNote.textContent = `Showing the first ${MAX_ROWS} of ${matches.length} releases.`;
}

/** Draws the format preference rows. Called only when settings change. */
export function renderFormats(el: Elements, settings: Settings): void {
  const last = settings.formats.length - 1;
  const rows = settings.formats.map((format, index) => {
    const row = document.createElement("li");
    row.className = format.enabled ? "format" : "format disabled";
    const rank = document.createElement("span");
    rank.className = "format-rank";
    rank.textContent = String(index + 1);

    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = format.enabled;
    checkbox.dataset.toggle = format.key;
    const text = document.createElement("span");
    text.textContent = FORMAT_LABELS[format.key];
    label.append(checkbox, text);

    const move = (direction: "up" | "down", symbol: string, disabled: boolean) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-button";
      button.textContent = symbol;
      button.disabled = disabled;
      button.dataset.move = direction;
      button.dataset.key = format.key;
      button.setAttribute("aria-label", `Move ${FORMAT_LABELS[format.key]} ${direction}`);
      return button;
    };
    row.append(rank, label, move("up", "↑", index === 0), move("down", "↓", index === last));
    return row;
  });
  el.formats.replaceChildren(...rows);
}
