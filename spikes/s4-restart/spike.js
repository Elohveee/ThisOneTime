/**
 * spike.js: connects the page to the S4 test flow.
 *
 * Purpose:      Show the right instruction and action for each phase.
 * Inputs:       Button clicks and the folder chosen in Chrome's picker.
 * Outputs:      Instructions and a formatted JSON report.
 * Failure mode: Cancelling the picker changes nothing. Failed checks appear in
 *               the report and can be retried.
 */
import { buildReport, getPhase, runCheck, startTest, REQUIRED_RESTARTS } from "./spike-core.js";
import { session, store } from "./store.js";

const instructions = document.querySelector("#instructions");
const primaryButton = document.querySelector("#primary");
const copyButton = document.querySelector("#copy");
const resetButton = document.querySelector("#reset");
const reportBlock = document.querySelector("#report");

/** Kept in memory so a click can request permission without extra delay. */
let state;

/** Instruction text and primary button label for each phase. */
function phaseContent(phase) {
  const passed = state?.observations.filter((entry) => entry.passed).length ?? 0;
  const restart = Math.min(passed + 1, REQUIRED_RESTARTS);
  const content = {
    choose: {
      text: "Choose or create an empty test folder, such as Music/TOT Test.",
      button: "Choose folder",
    },
    waiting: {
      text: `Now fully quit Chrome with Cmd+Q, reopen it, and click this extension's icon. This is restart ${restart} of ${REQUIRED_RESTARTS}.`,
      button: null,
    },
    check: {
      text: `Chrome restarted. Click Run check. If Chrome asks, choose "Allow on every visit" when offered. This is check ${restart} of ${REQUIRED_RESTARTS}.`,
      button: "Run check",
    },
    done: { text: "Test complete. Copy the report below.", button: null },
  };
  return content[phase];
}

/** Redraws the page from saved state. */
async function render() {
  const phase = getPhase(state, await session.isMarked());
  const content = phaseContent(phase);

  instructions.textContent = content.text;
  primaryButton.textContent = content.button ?? "";
  primaryButton.hidden = !content.button;
  primaryButton.dataset.phase = phase;
  resetButton.hidden = !state;

  const hasResults = Boolean(state?.observations.length);
  copyButton.hidden = !hasResults;
  reportBlock.hidden = !hasResults;
  // textContent treats the report as plain text, never as markup.
  reportBlock.textContent = hasResults ? JSON.stringify(buildReport(state), null, 2) : "";
}

primaryButton.addEventListener("click", async () => {
  primaryButton.disabled = true;
  try {
    if (primaryButton.dataset.phase === "choose") {
      const root = await window.showDirectoryPicker({ id: "thisonetime-s4", mode: "readwrite" });
      state = await startTest({ root, store, session, createId: () => crypto.randomUUID() });
    } else {
      await runCheck({ state, store, session });
    }
    await render();
  } catch (error) {
    if (error?.name !== "AbortError") {
      instructions.textContent = "Chrome refused that folder. Try a new subfolder inside Music.";
    }
  } finally {
    primaryButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(reportBlock.textContent);
  instructions.textContent = "Report copied.";
});

resetButton.addEventListener("click", async () => {
  await store.clear();
  await session.clear();
  state = undefined;
  await render();
});

state = await store.load();
await render();
