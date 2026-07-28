import { createContext, useContext, type ReactNode } from "react"
import { createPortal } from "react-dom"

/**
 * The Customization page header's action area, published to the active tab.
 *
 * A tab's primary actions belong on the one header the page already has, not in a
 * second toolbar row below the tab strip — that row costs vertical space every
 * tab pays for. The header owns the slot element; a tab renders into it with
 * {@link HeaderActions}, keeping its buttons inside its own React tree (and so
 * its own state, dialogs and handlers) while they appear beside the title.
 */
const HeaderActionsSlotContext = createContext<HTMLElement | null>(null)

export const HeaderActionsSlotProvider = HeaderActionsSlotContext.Provider

export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderActionsSlotContext)
  // Null on the first paint, before the slot element has been attached — and in
  // any other host that renders a tab standalone, where the actions simply don't
  // appear rather than crashing.
  return slot ? createPortal(children, slot) : null
}
