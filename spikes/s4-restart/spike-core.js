/**
 * spike-core.js: the Spike S4 test flow.
 *
 * Question:  Does a saved folder handle still work after Chrome restarts, with
 *            at most one permission prompt?
 *
 * Flow:      1. The user chooses a folder and a marker file is written.
 *            2. The user restarts Chrome and runs a check.
 *            3. The user restarts again and chooses "Allow on every visit".
 *            4. The user restarts once more. No prompt on this final check
 *               proves that the "every visit" choice actually persists.
 *
 * Inputs:    A folder handle plus injected `store` and `session` objects, which
 *            allows rehearsal outside Chrome.
 * Output:    A report containing only permission states, booleans, counts, and
 *            fixed reason codes. It never contains folder or file names.
 *
 * Safety:    Writes only inside `ThisOneTime S4 Test`. It never deletes files.
 */

const TEST_FOLDER = "ThisOneTime S4 Test";
const MARKER_FILE = "marker.txt";
const CHECK_FILE = "after-restart.txt";
const READ_WRITE = { mode: "readwrite" };

/** Successful restarts needed before the spike can pass. */
export const REQUIRED_RESTARTS = 3;

/** Replaces a small text file through Chrome's atomic writable stream. */
async function writeText(folder, name, text) {
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** Reads a text file from the folder. */
async function readText(folder, name) {
  const handle = await folder.getFileHandle(name);
  return (await handle.getFile()).text();
}

/** Counts checks that fully succeeded. */
const passedChecks = (state) => state.observations.filter((entry) => entry.passed).length;

/**
 * Decides which screen to show.
 *
 * @param {object|undefined} state Saved test state.
 * @param {boolean} sessionMarked True when Chrome has not restarted yet.
 * @returns {"choose"|"waiting"|"check"|"done"} The current phase.
 */
export function getPhase(state, sessionMarked) {
  if (!state) return "choose";
  if (passedChecks(state) >= REQUIRED_RESTARTS) return "done";
  return sessionMarked ? "waiting" : "check";
}

/** Writes the marker, saves the handle, and marks this browser session. */
export async function startTest({ root, store, session, createId }) {
  const nonce = createId();
  const folder = await root.getDirectoryHandle(TEST_FOLDER, { create: true });
  await writeText(folder, MARKER_FILE, nonce);
  const state = { handle: root, nonce, observations: [] };
  await store.save(state);
  await session.mark();
  return state;
}

/**
 * Checks access after a restart. Must be called directly from a user click,
 * because `requestPermission` is rejected without one.
 */
export async function runCheck({ state, store, session }) {
  const observation = {
    check: state.observations.length + 1,
    permissionBeforeClick: null,
    permissionAfterRequest: null,
    promptRequired: null,
    markerMatches: false,
    writeReadBackMatches: false,
    passed: false,
    failure: null,
  };

  try {
    const before = await state.handle.queryPermission(READ_WRITE);
    observation.permissionBeforeClick = before;
    observation.promptRequired = before !== "granted";

    const after = before === "granted" ? before : await state.handle.requestPermission(READ_WRITE);
    observation.permissionAfterRequest = after;

    if (after !== "granted") {
      observation.failure = "permission_not_granted";
    } else {
      const folder = await state.handle.getDirectoryHandle(TEST_FOLDER);
      observation.markerMatches = (await readText(folder, MARKER_FILE)) === state.nonce;

      const proof = `${state.nonce}:${observation.check}`;
      await writeText(folder, CHECK_FILE, proof);
      observation.writeReadBackMatches = (await readText(folder, CHECK_FILE)) === proof;

      observation.passed = observation.markerMatches && observation.writeReadBackMatches;
      if (!observation.passed) observation.failure = "file_check_failed";
    }
  } catch (error) {
    // Error messages can include paths, so keep only the standard error name.
    observation.failure = `unexpected_${error?.name ?? "error"}`;
  }

  state.observations.push(observation);
  await store.save(state);
  // A failed check can be retried now. A passed one needs another restart.
  if (observation.passed) await session.mark();
  return observation;
}

/** Builds the privacy-safe report from saved state. */
export function buildReport(state) {
  const passed = state.observations.filter((entry) => entry.passed);
  const latest = state.observations.at(-1) ?? null;
  const result =
    passed.length >= REQUIRED_RESTARTS ? "pass" : latest?.failure ? "fail" : "in_progress";

  return {
    spike: "S4",
    version: 1,
    result,
    reason: result === "fail" ? latest.failure : null,
    restartsPassed: passed.length,
    restartsRequired: REQUIRED_RESTARTS,
    resumedWithoutPrompt: passed.some((entry) => !entry.promptRequired),
    everyRestartNeededPrompt: passed.length > 0 && passed.every((entry) => entry.promptRequired),
    observations: state.observations,
  };
}
