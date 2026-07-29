/**
 * Wire Monaco to load from the app bundle rather than a CDN.
 *
 * `@monaco-editor/react` defaults to fetching Monaco off a CDN — no good for a
 * local-first app. Here we hand it the bundled `monaco-editor` and register the
 * language web workers via Vite's `?worker` imports, so syntax services (TS,
 * JSON, CSS, HTML) run off the main thread. Import this module once, before the
 * first editor mounts.
 */
import { loader } from "@monaco-editor/react"
import * as monaco from "monaco-editor"
import editorWorker from "monaco-editor/editor/editor.worker?worker"
import jsonWorker from "monaco-editor/languages/features/json/json.worker?worker"
import cssWorker from "monaco-editor/languages/features/css/css.worker?worker"
import htmlWorker from "monaco-editor/languages/features/html/html.worker?worker"
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker"

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker()
      case "css":
      case "scss":
      case "less":
        return new cssWorker()
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker()
      case "typescript":
      case "javascript":
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

loader.config({ monaco })
