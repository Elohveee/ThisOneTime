/**
 * background.ts: opens or focuses the ThisOneTime tab.
 *
 * Purpose:     Respond to the toolbar icon.
 * Why so small: Service workers stop when idle and have no DOMParser, so all
 *              real work runs in the app tab.
 * Permissions: `getContexts` finds the extension's own tab without the broader
 *              `tabs` permission.
 */
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.TAB],
    documentUrls: [url],
  });
  const existing = contexts[0];

  if (existing && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
});
