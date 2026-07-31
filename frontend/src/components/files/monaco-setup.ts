/**
 * Wire Monaco to load from the app bundle rather than a CDN, and configure its
 * language services for what this editor actually is.
 *
 * `@monaco-editor/react` defaults to fetching Monaco off a CDN — no good for a
 * local-first app. Here we hand it the bundled `monaco-editor` and register the
 * language web workers via Vite's `?worker` imports, so syntax services (TS,
 * JSON, CSS, HTML) run off the main thread. Import this module once, before the
 * first editor mounts.
 *
 * Registering those workers is not enough: left at their defaults they report a
 * screenful of errors that aren't real. See {@link configureLanguageDefaults}.
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

type CssOptions = Parameters<
  typeof monaco.css.cssDefaults.setOptions
>[0]

/**
 * CSS validation with Tailwind's at-rules demoted from errors to nothing.
 *
 * `unknownAtRules` is a real rule in the `vscode-css-languageservice` that backs
 * Monaco's CSS worker, and the worker hands it the whole options object
 * (`configure(this._languageSettings)`) — but Monaco's *public* `lint` type
 * predates the rule and doesn't list it. Hence the widened type rather than a
 * cast to `any`: the value is what the language service wants, and the only
 * thing being worked around is an out-of-date declaration.
 */
const CSS_OPTIONS: Omit<CssOptions, "lint"> & {
  lint?: NonNullable<CssOptions["lint"]> & {
    unknownAtRules?: "ignore" | "warning" | "error"
  }
} = {
  validate: true,
  lint: { unknownAtRules: "ignore" },
}

/**
 * Tell each language worker what kind of editor this is.
 *
 * Every worker defaults to "I am the whole toolchain for this file", which is
 * false here: this is a single-file view over a repo whose types, config schemas
 * and Tailwind build live on disk, outside the browser. Unconfigured, that
 * mismatch shows up as errors on correct code —
 *
 * - **TS/TSX/JS**: the TS worker type-checks each open file as a standalone
 *   program with default compiler options. There is no `tsconfig.json`, no
 *   `node_modules` and no sibling modules in its model graph, so every import is
 *   "Cannot find module", every JSX element is "Cannot use JSX unless the
 *   '--jsx' flag is provided", and every type inferred from an unresolved import
 *   is `any` with a follow-on error. Getting this *right* is structurally
 *   impossible in the browser — it needs a `tsserver`/LSP bridge on the backend
 *   with the project's own dependencies — so we turn semantic checking off
 *   rather than ship diagnostics we know to be wrong.
 * - **CSS**: Tailwind v4's at-rules (`@theme`, `@apply`, `@custom-variant`,
 *   `@utility`) are unknown to the stock CSS worker, which makes `index.css`
 *   unreadable under squiggles.
 * - **JSON**: `tsconfig.json`, `.vscode/*.json` and friends are JSON-with-
 *   comments, and the worker reports every comment and trailing comma as a
 *   syntax error.
 *
 * Syntactic validation stays **on** everywhere: an unbalanced brace is a real
 * error the worker can see from the file alone, and it needs no project graph.
 * There is deliberately no user-facing toggle — semantic validation here is
 * wrong for a structural reason, not a matter of preference.
 */
function configureLanguageDefaults() {
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
      // Suggestion diagnostics ("this could be an async function", …) are
      // inference-driven too, so they're as unreliable as the semantic ones.
      noSuggestionDiagnostics: true,
    })
    // Still set the options that decide how the file is *parsed*, so TSX and
    // modern syntax tokenize and syntax-check correctly.
    defaults.setCompilerOptions({
      target: monaco.typescript.ScriptTarget.Latest,
      jsx: monaco.typescript.JsxEmit.ReactJSX,
      moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
      allowJs: true,
      allowNonTsExtensions: true,
      noEmit: true,
    })
  }

  for (const defaults of [
    monaco.css.cssDefaults,
    monaco.css.scssDefaults,
    monaco.css.lessDefaults,
  ]) {
    defaults.setOptions(CSS_OPTIONS)
  }

  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    trailingCommas: "ignore",
    // No schema store to validate against, and `enableSchemaRequest` would have
    // the worker phone out to a schema URL — never, in a local-first app.
    schemaValidation: "ignore",
    enableSchemaRequest: false,
  })
}

configureLanguageDefaults()

loader.config({ monaco })
