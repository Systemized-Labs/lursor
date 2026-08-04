/**
 * localStorage scoped to a single pane.
 *
 * Dock tabs are no longer one-per-kind — a workspace can have two previews or
 * two editors open at once — so panel state that used to hang off the workspace
 * id alone (a preview's URL, say) needs a per-tab key, or every copy of that
 * panel would fight over one value. Tab ids are persisted with the dock layout,
 * so these keys survive a reload; {@link clearTabStorage} drops them when the
 * tab closes so dead tabs don't leak entries forever.
 */
const PREFIX = "lursor:tab:"

/** Storage key for one named slice of one tab's state. */
export const tabStorageKey = (tabId: string, name: string) =>
  `${PREFIX}${tabId}:${name}`

/** Forget everything stored for a tab — called when it closes. */
export function clearTabStorage(tabId: string): void {
  try {
    const prefix = `${PREFIX}${tabId}:`
    // Collect first: removing while iterating shifts the indices under us.
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // Best-effort: ignore quota / disabled-storage errors.
  }
}
