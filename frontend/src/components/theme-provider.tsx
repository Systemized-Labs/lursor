import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ComponentProps } from "react"

import { ThemeScheduler } from "@/components/theme-scheduler"

type ThemeProviderProps = ComponentProps<typeof NextThemesProvider>

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      {/* Drives the time-of-day theme schedule; must sit inside the provider. */}
      <ThemeScheduler />
      {children}
    </NextThemesProvider>
  )
}
