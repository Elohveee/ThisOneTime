/**
 * background.js: opens the spike page.
 *
 * Purpose:      Give the toolbar icon something to do.
 * Interactions: Clicking the extension icon opens spike.html in a new tab.
 * Why a tab:    Chrome's folder picker and permission prompts need a visible
 *               page and a real user click.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("spike.html") });
});
