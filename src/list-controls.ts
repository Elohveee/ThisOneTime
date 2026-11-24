/**
 * list-controls.ts: connects the release list's controls to app state.
 *
 * Purpose:  Handle filters, search, page buttons, and row actions.
 * Reset:    Changing the filter or search returns to page 1.
 * Saving:   Row actions are saved immediately, so they survive a closed tab.
 * Failure:  A failed save is reported in the status line.
 */
import { applyRowAction, type RowActionId } from "./release-actions.js";
import { saveLibrary } from "./storage.js";
import type { AppState, Elements, ReleaseFilter } from "./view.js";
import { releasePage } from "./view-releases.js";

/** Moves by one page, keeping focus usable at either end of the list. */
function turnPage(el: Elements, state: AppState, render: () => void, step: -1 | 1): void {
  state.page = releasePage(state).page + step;
  render();
  // The new page starts at the top of the list, not beside the page buttons.
  el.search.scrollIntoView({ block: "start" });
  const pressed = step === 1 ? el.pageNext : el.pagePrevious;
  const other = step === 1 ? el.pagePrevious : el.pageNext;
  (pressed.disabled ? other : pressed).focus({ preventScroll: true });
}

/** Attaches every release list event listener. */
export function connectReleaseList(el: Elements, state: AppState, render: () => void): void {
  el.filters.addEventListener("click", (event) => {
    const filter = (event.target as HTMLElement).dataset.filter as ReleaseFilter | undefined;
    if (!filter) return;
    state.filter = filter;
    state.page = 1;
    render();
  });

  el.search.addEventListener("input", () => {
    state.search = el.search.value;
    state.page = 1;
    render();
  });

  el.pagePrevious.addEventListener("click", () => turnPage(el, state, render, -1));
  el.pageNext.addEventListener("click", () => turnPage(el, state, render, 1));

  el.releases.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    const library = state.library;
    const release = library?.releases.find((entry) => entry.key === button?.dataset.key);
    if (!button || button.disabled || !library || !release) return;

    applyRowAction(library, release, button.dataset.action as RowActionId);
    render();
    void saveLibrary(library).catch(() => {
      state.notice = "Could not save that change. Try again.";
      render();
    });
  });
}
