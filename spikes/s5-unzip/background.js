/**
 * background.js: opens the spike page.
 *
 * Purpose:      Give the toolbar icon something to do.
 * Interactions: Clicking the extension icon opens spike.html in a new tab.
 * Why a tab:    Long downloads and extraction would not survive in a service
 *               worker, which Chrome stops when idle.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("spike.html") });
});
