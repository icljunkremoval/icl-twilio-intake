const APP_STATE_KEY = "operator-os-state-v1";

export function loadPersistedState<T>(): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(APP_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function savePersistedState<T>(state: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
  } catch {
    // intentionally ignored: storage can fail in private mode
  }
}
