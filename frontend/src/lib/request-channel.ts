/**
 * A cross-component channel for "open this thing" requests.
 *
 * The shape three modules were each a copy of — `open-file`, `open-preview` and
 * `open-thread` were 168 lines differing only in the request type and four function
 * names. What they all needed is the same: a place for a request to be *parked*
 * where a component with no prop path to the surface that answers it can leave one,
 * and a way for that surface to pick it up exactly once.
 *
 * The pattern exists because a pane owns its own state and only mounts when the
 * layout has one. A command palette entry, a right-click on a chat link and a
 * sidebar conversation row all sit outside the pane layer with no reference to the
 * pane that should answer them, and the URL is not the answer either — panes address
 * themselves through their own params, and `?c=` is written *from* the focused pane
 * rather than read to build the layout (the plan's §4).
 *
 * So: the requester parks, the shell notices and ensures a pane of the right kind,
 * and the surface consumes once mounted.
 *
 * **One parked request at a time, deliberately.** Not a queue: these are all
 * "navigate to X" and the last ask is the one the user means. Two files clicked in
 * quick succession should land you on the second, not open both.
 *
 * **Dependency-free on purpose.** This module is reached from the shell on every
 * route — no React, no dockview, nothing but a module-scope `let` and a `Set` of
 * listeners. Anything imported here lands in the entry chunk past the lazy pane
 * host.
 */

export interface RequestChannel<T extends { workspaceId: string }> {
  /** Park a request and notify subscribers. */
  request: (value: T) => void
  /** Look at the pending request without clearing it. */
  peek: () => T | null
  /**
   * Take the pending request if it targets `workspaceId`, clearing it so it opens
   * exactly once. Null when there is nothing for this workspace.
   *
   * The workspace match is what makes a request survive the navigation to get to it:
   * a palette entry for a file in another repo parks, the app routes there, and only
   * the shell that can actually answer takes it. Which also means an undefined
   * `workspaceId` — outside a workspace — never consumes.
   */
  consume: (workspaceId: string | undefined) => T | null
  /** Subscribe to request changes; returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void
}

export function createRequestChannel<
  T extends { workspaceId: string },
>(): RequestChannel<T> {
  let pending: T | null = null
  const listeners = new Set<() => void>()

  return {
    request(value) {
      pending = value
      for (const listener of listeners) listener()
    },
    peek() {
      return pending
    },
    consume(workspaceId) {
      if (pending && workspaceId && pending.workspaceId === workspaceId) {
        const value = pending
        pending = null
        return value
      }
      return null
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
