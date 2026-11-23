/**
 * background.js: opens the spike page.
 *
 * Purpose:      Give the toolbar icon something to do.
 * Interactions: Clicking the extension icon opens spike.html in a new tab.
 * Why a tab:    The folder picker and long-running streams belong in a page,
 *               because service workers stop when idle.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("spike.html") });
});
