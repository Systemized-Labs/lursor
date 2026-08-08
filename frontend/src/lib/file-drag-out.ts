import type { DragEvent } from "react"
import { toast } from "sonner"

import { filesApi } from "@/api/files"
import { isElectron } from "@/lib/platform"

/**
 * Dragging a workspace file *out* of Lursor — into Finder, Slack, an editor, a
 * chat box.
 *
 * Two mechanisms, because a window can only offer what its host allows:
 *
 * - **Desktop.** Chromium can't promise a file to the OS from the renderer; only
 *   `webContents.startDrag` in the main process can. So the HTML drag is cancelled
 *   and the item handed to main (see the `file:drag` handler in electron/main.cjs),
 *   which drags the real path — or, on a remote connection, a temp copy of the
 *   downloaded bytes.
 * - **Browser.** No native drag is available, so the drop carries Chromium's
 *   `DownloadURL` promise, which Finder and most macOS/Windows targets accept and
 *   fetch from the backend on drop. Firefox and Safari ignore it and fall back to
 *   the plain-text path — which is the useful payload for a terminal or an editor's
 *   command bar anyway, so it is always set.
 *
 * A directory can only go out as a real path, which means the desktop app on a
 * local connection. Elsewhere the text payload is all it can offer.
 */
export interface DragOutItem {
  workspaceId: string
  /** POSIX path relative to the workspace root. */
  path: string
  name: string
  isDir: boolean
  /**
   * The item's absolute path on the backend host, or "" when the workspace root
   * isn't known yet. Without it a desktop drag has nothing to hand the OS.
   */
  absPath: string
}

/**
 * A drop target reads the *first* format it understands, so what a mime type is
 * worth here is only ever the filename beside it — Chromium names the dropped file
 * from that, and the drop target sniffs the bytes. One honest type beats a lookup
 * table that would have to agree with the backend's.
 */
const DOWNLOAD_MIME = "application/octet-stream"

/**
 * Begin a drag of `item` out of the app. Call from a row's `onDragStart`.
 *
 * Failures are reported here rather than returned: by the time a staged download
 * fails the gesture is long over, and the caller has no way to say so.
 */
export function startFileDragOut(event: DragEvent, item: DragOutItem): void {
  const bridge = typeof window !== "undefined" ? window.electron : undefined

  if (isElectron && bridge?.startFileDrag) {
    // Cancels the HTML drag outright — main is about to start a native one in its
    // place, and two drags for one gesture is not a state the OS has.
    event.preventDefault()
    void bridge
      .startFileDrag({
        workspaceId: item.workspaceId,
        path: item.path,
        name: item.name,
        isDir: item.isDir,
        absPath: item.absPath,
      })
      .then((result) => {
        if (!result.ok) toast.error(result.error)
      })
      .catch(() => toast.error(`Couldn’t drag ${item.name} out.`))
    return
  }

  const data = event.dataTransfer
  data.effectAllowed = "copy"
  // The path if we have one, the workspace-relative path if we don't: both are
  // worth pasting, and an empty drag is not.
  data.setData("text/plain", item.absPath || item.path)
  if (!item.isDir) {
    data.setData(
      "DownloadURL",
      `${DOWNLOAD_MIME}:${item.name}:${filesApi.rawUrl(item.workspaceId, item.path)}`
    )
  }
}
