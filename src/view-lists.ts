/**
 * view-lists.ts: draws the format preference rows.
 *
 * Purpose:  Keep repeated format row rendering apart from the main view.
 * Safety:   Labels come from a fixed list and are set with `textContent`.
 */
import { FORMAT_LABELS } from "./formats.js";
import type { Settings } from "./types.js";
import type { Elements } from "./view.js";

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
