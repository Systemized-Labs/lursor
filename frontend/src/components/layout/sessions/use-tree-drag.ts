import { useCallback, useState } from "react"
import type { DragEvent } from "react"

import type {
  RailDragged,
  RailDrop,
  WorkspaceTree,
} from "@/components/layout/use-workspace-tree"

function sameDrop(a: RailDrop | null, b: RailDrop): boolean {
  if (a === null || a.kind !== b.kind) return false
  if (a.kind === "root" && b.kind === "root") return a.index === b.index
  if (a.kind === "folder" && b.kind === "folder") {
    return a.folderId === b.folderId && a.index === b.index
  }
  return false
}

export interface RowDragHandlers {
  draggable: boolean
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
  isDragging: boolean
  /** A row is about to be inserted above this one. */
  isDropTarget: boolean
}

export interface TreeDrag {
  /** Something is in hand, so the drop floors should be reachable. */
  active: boolean
  dragged: RailDragged | null
  /** The folder a workspace is hovering, about to be filed into. */
  fileInto: string | null
  setFileInto: (folderId: string | null) => void
  setDropTarget: (target: RailDrop | null) => void
  isDropTarget: (target: RailDrop) => boolean
  end: () => void
  /** Handlers for a row that a drop would land *before*. */
  rowDrag: (item: RailDragged, target: RailDrop) => RowDragHandlers
}

/**
 * Drag-to-rearrange for the PROJECTS list, lifted out of `nav-rail` unchanged.
 *
 * It lives in a hook rather than inline because two rows need it and each has to
 * know whether *it* is the current drop target — and, for a folder, whether the
 * drop means "before me" or "into me". Holding that in the list and passing it
 * down is what makes the highlight honest.
 *
 * The one rule worth restating: groups do not nest, so a slot inside one is not
 * somewhere a group can go. Refusing the dragover — rather than quietly
 * redirecting the drop to the group's own row — means nothing lights up, so
 * nothing promises a landing spot it will not use.
 */
export function useTreeDrag(tree: WorkspaceTree): TreeDrag {
  const [dragged, setDragged] = useState<RailDragged | null>(null)
  const [dropTarget, setDropTarget] = useState<RailDrop | null>(null)
  const [fileInto, setFileInto] = useState<string | null>(null)

  const end = useCallback(() => {
    setDragged(null)
    setDropTarget(null)
    setFileInto(null)
  }, [])

  const rowDrag = useCallback(
    (item: RailDragged, target: RailDrop): RowDragHandlers => {
      const rejects = dragged?.kind === "folder" && target.kind === "folder"
      return {
        draggable: true,
        onDragStart: (event: DragEvent) => {
          setDragged(item)
          event.dataTransfer.effectAllowed = "move"
          // Firefox ignores a drag with no payload; the row itself is carried in
          // component state, so the data is a formality.
          event.dataTransfer.setData("text/plain", item.id)
        },
        onDragOver: (event: DragEvent) => {
          if (!dragged || rejects) return
          event.preventDefault()
          setDropTarget(target)
          setFileInto(null)
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault()
          if (!rejects && dragged && dragged.id !== item.id) {
            tree.move(dragged, target)
          }
          end()
        },
        onDragEnd: end,
        isDragging: dragged?.id === item.id,
        isDropTarget:
          !rejects && sameDrop(dropTarget, target) && dragged?.id !== item.id,
      }
    },
    [dragged, dropTarget, tree, end]
  )

  return {
    active: dragged !== null,
    dragged,
    fileInto,
    setFileInto,
    setDropTarget,
    isDropTarget: (target: RailDrop) => sameDrop(dropTarget, target),
    end,
    rowDrag,
  }
}
