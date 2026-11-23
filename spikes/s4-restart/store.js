/**
 * store.js: saves the spike's state across browser restarts.
 *
 * Purpose:   Keep the folder handle in IndexedDB and detect a real restart.
 * Why IDB:   Folder handles can be stored by IndexedDB, but not by
 *            chrome.storage, which accepts only JSON-style data.
 * Restart:   chrome.storage.session is cleared when Chrome restarts, so a
 *            missing session mark means this is a new browser session.
 * Caution:   Reloading the extension also clears the session mark.
 */

const DB_NAME = "thisonetime-s4";
const STORE_NAME = "state";
const STATE_KEY = "current";
const SESSION_KEY = "s4SessionMark";

/** Opens the database, creating its single object store on first use. */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one IndexedDB operation and closes the connection afterward. */
async function withStore(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Durable test state, including the chosen folder handle. */
export const store = {
  load: () => withStore("readonly", (objects) => objects.get(STATE_KEY)),
  save: (state) => withStore("readwrite", (objects) => objects.put(state, STATE_KEY)),
  clear: () => withStore("readwrite", (objects) => objects.delete(STATE_KEY)),
};

/** A mark that exists only until Chrome restarts. */
export const session = {
  isMarked: async () => {
    const values = await chrome.storage.session.get(SESSION_KEY);
    return values[SESSION_KEY] === true;
  },
  mark: () => chrome.storage.session.set({ [SESSION_KEY]: true }),
  clear: () => chrome.storage.session.remove(SESSION_KEY),
};
