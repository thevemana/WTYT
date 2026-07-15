// WTYT — saved-notes store (0.4.0 MVP). One key per note over chrome.storage.local,
// prefixed `wtytnote:<id>` — a distinct namespace from the `wtyt:` analysis cache, so
// the options-page "Clear cached analyses" sweep never touches saved notes.
//
// A note = the analysis fields (verdict, one_liner, key_takeaways, read_instead,
// transcript_text, scores…) plus { id, url, title, channel, thumbnail, savedAt }.
// Thumbnails are the derived i.ytimg.com URL, never a stored blob.
//
// Loaded in both worlds: content_scripts (cards.js Save button) and the notes page.

const WTYT_NOTES = (() => {
  const PREFIX = 'wtytnote:';
  const keyFor = (id) => PREFIX + id;

  function save(note) {
    const record = { ...note, savedAt: note.savedAt || Date.now() };
    return new Promise((resolve) =>
      chrome.storage.local.set({ [keyFor(note.id)]: record }, () => resolve(record))
    );
  }

  function get(id) {
    return new Promise((resolve) =>
      chrome.storage.local.get(keyFor(id), (items) => resolve(items[keyFor(id)] || null))
    );
  }

  // Newest first — the Apple-Notes feel wants the most recent save on top.
  function list() {
    return new Promise((resolve) =>
      chrome.storage.local.get(null, (items) => {
        const notes = Object.keys(items)
          .filter((k) => k.startsWith(PREFIX))
          .map((k) => items[k]);
        notes.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        resolve(notes);
      })
    );
  }

  function remove(id) {
    return new Promise((resolve) =>
      chrome.storage.local.remove(keyFor(id), () => resolve())
    );
  }

  return { save, get, list, remove, PREFIX };
})();
