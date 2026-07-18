import { lazy, type ComponentType } from "react"
import { GameController, FlagBanner, Bird } from "@phosphor-icons/react"

export type MinigameId = "dino" | "golf" | "duckhunt"

export type MinigameMeta = {
  id: MinigameId
  name: string
  blurb: string
  Icon: ComponentType<{ className?: string }>
  Component: ComponentType<{ className?: string }>
}

export const MINIGAMES: MinigameMeta[] = [
  {
    id: "dino",
    name: "Dino Run",
    blurb: "Hop the cacti",
    Icon: GameController,
    Component: lazy(() => import("./DinoRunner")),
  },
  {
    id: "golf",
    name: "Golf",
    blurb: "Tap to swing",
    Icon: FlagBanner,
    Component: lazy(() => import("./GolfGame")),
  },
  {
    id: "duckhunt",
    name: "Duck Hunt",
    blurb: "Shoot the ducks",
    Icon: Bird,
    Component: lazy(() => import("./DuckHuntGame")),
  },
]

const STORAGE_KEY = "lursor.minigame.selected"

export function loadSelectedGame(): MinigameId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && MINIGAMES.some((g) => g.id === raw)) return raw as MinigameId
  } catch {
    // storage unavailable — fall through to default
  }
  return "dino"
}

export function saveSelectedGame(id: MinigameId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // best-effort
  }
}
