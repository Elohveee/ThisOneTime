/**
 * background.js: opens the spike page.
 *
 * Purpose:      Give the toolbar icon something to do.
 * Interactions: Clicking the extension icon opens spike.html in a new tab.
 * Why so small: Service workers stop when idle and have no DOMParser, so all
 *               real work happens in the page. The final extension does too.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("spike.html") });
});
