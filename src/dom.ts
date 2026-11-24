/**
 * dom.ts: finds the page's elements.
 *
 * Purpose:  Keep element IDs in one place, matching app.html.
 * Usage:    const elements = getElements();
 */
import type { Elements } from "./view.js";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Finds every element the view updates. */
export function getElements(): Elements {
  return {
    account: byId("account"),
    status: byId("status"),
    progress: byId("progress"),
    progressCount: byId("progress-count"),
    summary: byId("summary"),
    primary: byId("primary"),
    settings: byId("settings"),
    folderName: byId("folder-name"),
    chooseFolder: byId("choose-folder"),
    formats: byId("formats"),
    autoUnzip: byId("auto-unzip"),
    includeHidden: byId("include-hidden"),
    filters: byId("filters"),
    releases: byId("releases"),
    listNote: byId("list-note"),
  };
}
