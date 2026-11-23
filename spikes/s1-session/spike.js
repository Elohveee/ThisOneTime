/**
 * spike.js: connects the page's buttons to the test in spike-core.js.
 *
 * Purpose:      Keep browser UI code apart from the testable flow.
 * Inputs:       Clicks on Run and Copy.
 * Outputs:      Status text and a formatted JSON report.
 * Failure mode: spike-core.js always returns a report, so failures appear in
 *               the report instead of as an uncaught error.
 */
import { runSpike } from "./spike-core.js";

const runButton = document.querySelector("#run");
const copyButton = document.querySelector("#copy");
const statusText = document.querySelector("#status");
const reportBlock = document.querySelector("#report");

/** Parses downloaded HTML without running its scripts or loading its assets. */
const parseHtml = (html) => new DOMParser().parseFromString(html, "text/html");

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  copyButton.disabled = true;
  reportBlock.hidden = true;

  const report = await runSpike({
    // Calling through globalThis keeps fetch bound to the browser window.
    fetchImpl: (...args) => globalThis.fetch(...args),
    parseHtml,
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
