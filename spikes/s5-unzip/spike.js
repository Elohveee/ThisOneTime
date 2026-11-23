/**
 * spike.js: connects the page's buttons to the test in spike-core.js.
 *
 * Purpose:      Request folder access, then run the testable flow.
 * Inputs:       Clicks on Run and Copy, and the folder chosen in Chrome's picker.
 * Outputs:      Status text and a formatted JSON report.
 * Failure mode: Cancelling the picker returns to Ready. Refused folders show a
 *               short message so another folder can be chosen.
 */
import { runSpike } from "./spike-core.js";

const runButton = document.querySelector("#run");
const copyButton = document.querySelector("#copy");
const statusText = document.querySelector("#status");
const reportBlock = document.querySelector("#report");

/** Parses downloaded HTML without running its scripts or loading its assets. */
const parseHtml = (html) => new DOMParser().parseFromString(html, "text/html");

runButton.addEventListener("click", async () => {
  let root;
  try {
    // The picker must open directly from this click, or Chrome rejects it.
    root = await window.showDirectoryPicker({ id: "thisonetime-s5", mode: "readwrite" });
  } catch (error) {
    statusText.textContent =
      error?.name === "AbortError"
        ? "Ready."
        : "Chrome refused that folder. Try a new subfolder inside Music.";
    return;
  }

  runButton.disabled = true;
  copyButton.disabled = true;
  reportBlock.hidden = true;

  const report = await runSpike({
    fetchImpl: (...args) => globalThis.fetch(...args),
    parseHtml,
    root,
    onProgress: (message) => {
      statusText.textContent = message;
    },
  });

  // textContent treats the report as plain text, never as markup.
  reportBlock.textContent = JSON.stringify(report, null, 2);
  reportBlock.hidden = false;
  statusText.textContent = `Finished: ${report.result}. Copy the report below.`;
  runButton.disabled = false;
  copyButton.disabled = false;
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(reportBlock.textContent);
  statusText.textContent = "Report copied.";
});
