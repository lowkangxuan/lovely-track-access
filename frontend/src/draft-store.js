/**
 * Editor draft persistence — the 8 uploaded instance CSVs, the chosen scenario
 * and the weather toggle survive logout/login and page reloads via localStorage.
 * The active schedule itself is persisted server-side (backend/state).
 */

export const DRAFT_KEY = "tas.editorDraft.v1";
const MAX_BYTES = 4 * 1024 * 1024; // stay under the usual 5 MB localStorage quota

/** Serialisable form of a draft: File objects become { fileName, text }. */
export async function serializeDraft(draft) {
  const entries = {};
  for (const [name, entry] of Object.entries(draft?.entries ?? {})) {
    if (!entry?.file) continue;
    const { file, ...rest } = entry;
    entries[name] = { ...rest, fileName: file.name, text: await file.text() };
  }
  return { entries, scenario: draft?.scenario ?? null, weatherAware: !!draft?.weatherAware, savedAt: new Date().toISOString() };
}

/** Rebuild File objects from a stored draft. */
export function deserializeDraft(stored) {
  if (!stored || typeof stored !== "object") return null;
  const entries = {};
  for (const [name, entry] of Object.entries(stored.entries ?? {})) {
    if (typeof entry?.text !== "string") continue;
    const { fileName, text, ...rest } = entry;
    entries[name] = { ...rest, file: new File([text], fileName || name, { type: "text/csv" }) };
  }
  return { entries, scenario: stored.scenario ?? null, weatherAware: !!stored.weatherAware };
}

export async function saveDraft(draft, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    const json = JSON.stringify(await serializeDraft(draft));
    if (json.length > MAX_BYTES) return false;
    storage.setItem(DRAFT_KEY, json);
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(storage = globalThis.localStorage) {
  if (!storage) return null;
  try {
    return deserializeDraft(JSON.parse(storage.getItem(DRAFT_KEY) || "null"));
  } catch {
    return null;
  }
}

export function clearDraft(storage = globalThis.localStorage) {
  try { storage?.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}
