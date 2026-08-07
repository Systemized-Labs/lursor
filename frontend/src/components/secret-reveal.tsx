import { Copy, Eye, EyeSlash } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { copyToClipboard } from "@/lib/utils"

interface SecretRevealProps {
  /** Fetches the secret in full. Called only when the user asks for it. */
  fetchSecret: () => Promise<string>
  /** Noun used in buttons and toasts, e.g. "key" or "token". */
  label?: string
  /** Disables both actions (e.g. while another mutation is in flight). */
  disabled?: boolean
}

/**
 * Copy / show controls for a stored secret the UI otherwise treats as
 * write-only. The value is fetched on demand rather than held in a query cache,
 * and dropped again as soon as it is hidden.
 *
 * "Show" is not just a convenience: `navigator.clipboard` is unavailable on a
 * plain-HTTP LAN origin, and the legacy fallback in `copyToClipboard` can still
 * fail there — reading the value off the screen is then the only way out.
 */
export function SecretReveal({
  fetchSecret,
  label = "secret",
  disabled = false,
}: SecretRevealProps) {
  const [value, setValue] = useState<string | null>(null)
  const [busy, setBusy] = useState<"copy" | "show" | null>(null)

  async function handleCopy() {
    setBusy("copy")
    try {
      const secret = value ?? (await fetchSecret())
      const ok = await copyToClipboard(secret)
      if (!ok) throw new Error("Could not copy to the clipboard")
      toast.success(`Copied ${label} to clipboard`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to copy ${label}`)
    } finally {
      setBusy(null)
    }
  }

  async function handleToggle() {
    if (value) {
      setValue(null)
      return
    }
    setBusy("show")
    try {
      setValue(await fetchSecret())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to read ${label}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={disabled || busy !== null}
        >
          {busy === "copy" ? (
            <DotGridLoader size="xs" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          Copy {label}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleToggle}
          disabled={disabled || busy !== null}
        >
          {busy === "show" ? (
            <DotGridLoader size="xs" />
          ) : value ? (
            <EyeSlash className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
          {value ? "Hide" : "Show"}
        </Button>
      </div>
      {value ? (
        <p className="break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground select-all">
          {value}
        </p>
      ) : null}
    </div>
  )
}
