import { fileKind } from "@/components/files/file-icon"
import { deriveFileChanges } from "@/agui/file-changes"
import type { ChatMessage } from "@/agui/types"

/**
 * Summary of the files an assistant turn changed, shown at the end of the turn.
 * The file list scrolls once it grows past a few rows so a large change set
 * never dominates the transcript. Additions/deletions are approximated from the
 * turn's tool calls (see {@link deriveFileChanges}).
 */
export function ChatFilesChanged({ messages }: { messages: ChatMessage[] }) {
  const files = deriveFileChanges(messages)
  if (files.length === 0) return null

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {files.length} File{files.length === 1 ? "" : "s"} Changed
        </span>
        <span className="text-xs text-muted-foreground">Review</span>
      </div>
      <div className="max-h-48 overflow-y-auto border-t border-border/40">
        {files.map((file) => {
          const { Icon } = fileKind(file.name)
          return (
            <div
              key={file.path}
              className="flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/50"
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="truncate text-foreground" title={file.path}>
                {file.name}
              </span>
              <span className="ml-auto flex flex-shrink-0 items-center gap-2 font-mono">
                {file.additions > 0 && (
                  <span className="text-success">+{file.additions}</span>
                )}
                {file.deletions > 0 && (
                  <span className="text-destructive">-{file.deletions}</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
