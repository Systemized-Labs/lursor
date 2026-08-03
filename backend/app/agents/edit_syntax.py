"""Tell the agent immediately when its own edit left a file unparseable.

We run the ``hashline`` edit format, where a stale anchor can splice a
replacement into the wrong place (see ``agents/file_editing.py`` and
``docs/FILE-EDITING-AUDIT.md``). The failure that produces is a *syntax* failure,
and nothing in the stack reported it: there is no LSP, no lint hook, no
diagnostics tool. Broken code surfaced later — browser QA's console logs, the
goal evaluator — by which point the agent had usually built on top of it. This is
the same signal, one tool call earlier.

Deliberately narrow, on three axes:

- **Syntax, not semantics.** "Your edit left this file unparseable at line N" is
  what a mis-anchored splice produces. Type errors are a different problem with a
  slower loop that already exists, and a project-wide typecheck would also report
  pre-existing errors the agent then chases.
- **Delta only.** The file is parsed before and after, and only breakage the edit
  *introduced* is reported. A file that was already broken stays the agent's
  business, not ours — without this the check is noise on any work-in-progress
  file.
- **No installs, no probing where a parser is built in.** Python, JSON, TOML and
  YAML are checked in-process with the standard library (plus PyYAML, which is
  already in the environment and skipped if it ever isn't). For JS/TS the
  workspace's own tooling is probed once and the check is skipped silently when
  none of it is there — see :func:`_js_checker`.

Cost: two extra reads on an edit to a file with a checkable extension, and no
subprocess at all outside JS/TS.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic_ai.capabilities import AbstractCapability, ValidatedToolArgs
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai_backends import ensure_async

from app.agents.file_editing import (
    HASHLINE_EDIT_TOOL,
    STR_REPLACE_EDIT_TOOL,
    WRITE_TOOL,
)

logger = logging.getLogger(__name__)

_EDIT_TOOLS = (WRITE_TOOL, HASHLINE_EDIT_TOOL, STR_REPLACE_EDIT_TOOL)

# Files above this size are skipped: a minified bundle or a data blob is not what
# this check is for, and parsing one on every edit is pure latency.
MAX_CHECK_BYTES = 2 * 1024 * 1024

# How long a JS/TS checker gets before we give up and stay quiet.
JS_CHECK_TIMEOUT = 10.0

_JS_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"})

# Single-file, syntax-only parse via the classic TypeScript compiler API.
# `transpileModule` with `reportDiagnostics` returns *syntactic* diagnostics only —
# no type checking, no program construction, no tsconfig resolution — which is
# exactly the scope this module wants. Category 1 is Error.
_TS_SCRIPT = """
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const [root, file] = process.argv.slice(1);
const ts = createRequire(path.join(root, "package.json"))("typescript");
if (typeof ts.transpileModule !== "function") process.exit(3);
const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  reportDiagnostics: true,
  fileName: file,
  compilerOptions: { target: "esnext", jsx: "preserve", allowJs: true },
});
const errors = (out.diagnostics || []).filter((d) => d.category === 1);
for (const d of errors) {
  const at = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
  const where = at ? `line ${at.line + 1}` : "unknown line";
  console.log(`${where}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}
process.exit(errors.length ? 1 : 0);
"""


def _python_problem(text: str, path: str) -> str | None:
    try:
        compile(text, path, "exec")
    except SyntaxError as exc:
        where = f"line {exc.lineno}" if exc.lineno else "unknown line"
        return f"{where}: {exc.msg}"
    except ValueError as exc:
        # A null byte or an over-deep literal — still "this will not import".
        return str(exc)
    return None


def _json_problem(text: str, path: str) -> str | None:
    try:
        json.loads(text)
    except json.JSONDecodeError as exc:
        return f"line {exc.lineno}: {exc.msg}"
    return None


def _toml_problem(text: str, path: str) -> str | None:
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        return str(exc)
    return None


def _yaml_problem(text: str, path: str) -> str | None:
    try:
        import yaml
    except ImportError:  # pragma: no cover — PyYAML is present in this environment
        return None
    try:
        yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        problem = getattr(exc, "problem", None) or str(exc).split("\n")[0]
        where = f"line {mark.line + 1}" if mark is not None else "unknown line"
        return f"{where}: {problem}"
    return None


# Extension → in-process checker. JS/TS is handled separately because it needs the
# workspace's own tooling.
_IN_PROCESS: dict[str, Any] = {
    ".py": _python_problem,
    ".pyi": _python_problem,
    ".json": _json_problem,
    ".toml": _toml_problem,
    ".yaml": _yaml_problem,
    ".yml": _yaml_problem,
}


@dataclass(frozen=True)
class _JsChecker:
    """How to syntax-check a JS/TS file in one workspace, or ``None`` if we can't."""

    kind: str
    argv_prefix: tuple[str, ...] = ()

    def argv(self, root: Path, file: str, scratch: Path) -> list[str]:
        if self.kind == "esbuild":
            # Parses and throws the output away; a syntax error is exit 1 with the
            # message on stderr. `--log-level=error` keeps warnings out of it. The
            # output goes to the caller's scratch directory rather than
            # `/dev/null`, which does not exist on Windows.
            return [
                *self.argv_prefix,
                file,
                "--log-level=error",
                f"--outfile={scratch / 'out.js'}",
            ]
        return [*self.argv_prefix, "-e", _TS_SCRIPT, str(root), file]


def _find_js_checker(root: Path) -> _JsChecker | None:
    """First usable JS/TS syntax checker in ``root``, preferring the cheapest.

    ``esbuild`` is a single native exec, so it wins when a workspace has it.
    Otherwise the classic TypeScript compiler API is driven through Node — which
    covers TS 5/6 workspaces but *not* TypeScript 7: the native rewrite dropped
    the single-file ``transpileModule`` entry point, and its replacement needs a
    whole ``Program`` (i.e. type checking) to report anything. Nor is there a
    fallback in a Vite 8 project, whose bundler is rolldown: it keeps its parser
    inside the native binary rather than shipping a JS-callable one, and
    ``@oxc-project/types`` is types only.

    Those workspaces get no JS/TS check, which is the intended failure mode —
    installing a parser into someone's project to satisfy a lint pass is worse
    than staying quiet.
    """
    esbuild = root / "node_modules" / ".bin" / "esbuild"
    if esbuild.is_file() and os.access(esbuild, os.X_OK):
        return _JsChecker(kind="esbuild", argv_prefix=(str(esbuild),))

    node = shutil.which("node")
    if node is not None and (root / "node_modules" / "typescript").is_dir():
        return _JsChecker(kind="typescript", argv_prefix=(node,))

    return None


@dataclass
class EditSyntaxCheck(AbstractCapability[Any]):
    """Append "your edit broke this file" to an edit result, when it did.

    One instance per agent build; the JS/TS checker probe is cached on it, so a
    workspace with no usable parser is probed once rather than on every edit.
    """

    _js_checkers: dict[str, _JsChecker | None] = field(default_factory=dict)

    async def wrap_tool_execute(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        handler: Any,
    ) -> Any:
        if call.tool_name not in _EDIT_TOOLS:
            return await handler(args)

        backend = getattr(getattr(ctx, "deps", None), "backend", None)
        path = args.get("path") if isinstance(args, dict) else None
        if backend is None or not isinstance(path, str):
            return await handler(args)

        suffix = Path(path).suffix.lower()
        if suffix not in _IN_PROCESS and suffix not in _JS_SUFFIXES:
            return await handler(args)

        before = await self._read(backend, path)
        result = await handler(args)
        if isinstance(result, str) and result.startswith("Error"):
            return result

        after = await self._read(backend, path)
        if after is None:
            return result

        problem = await self._problem(backend, path, suffix, after)
        if problem is None:
            return result
        # Pre-existing breakage is not this edit's fault, and reporting it turns
        # every edit to a work-in-progress file into a false alarm.
        if before is not None and await self._problem(backend, path, suffix, before) is not None:
            return result

        logger.info("edit to %s left it unparseable: %s", path, problem)
        return (
            f"{result}\n\nSyntax check: this edit left {path} unparseable — "
            f"{problem}. The write itself succeeded; re-read the file and fix it "
            "before moving on."
        )

    async def _read(self, backend: Any, path: str) -> str | None:
        """File contents as text, or ``None`` when it is missing or too big."""
        try:
            async_backend = ensure_async(backend)
            if not await async_backend.exists(path):
                return None
            raw = await async_backend.read_bytes(path)
        except Exception:  # noqa: BLE001 — a probe failure must not affect the edit
            return None
        if len(raw) > MAX_CHECK_BYTES:
            return None
        return raw.decode("utf-8", errors="replace")

    async def _problem(self, backend: Any, path: str, suffix: str, text: str) -> str | None:
        checker = _IN_PROCESS.get(suffix)
        if checker is not None:
            return checker(text, path)
        return await self._js_problem(backend, path, text)

    async def _js_problem(self, backend: Any, path: str, text: str) -> str | None:
        """Syntax-check JS/TS with the workspace's own tooling, or skip.

        The candidate content is written to a temp file beside nothing — the
        checkers take a path, and the "before" text no longer exists on disk by
        the time we need it — so the file is materialised in the OS temp dir with
        the original extension, which is what decides how it is parsed.
        """
        root = _root_of(backend)
        if root is None:
            return None
        key = str(root)
        if key not in self._js_checkers:
            self._js_checkers[key] = _find_js_checker(root)
            logger.debug(
                "js syntax checker for %s: %s",
                key,
                getattr(self._js_checkers[key], "kind", "none"),
            )
        checker = self._js_checkers[key]
        if checker is None:
            return None

        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / f"candidate{Path(path).suffix}"
            candidate.write_text(text, encoding="utf-8")
            try:
                process = await asyncio.create_subprocess_exec(
                    *checker.argv(root, str(candidate), Path(tmp)),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(root),
                )
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=JS_CHECK_TIMEOUT
                )
            except (TimeoutError, OSError) as exc:
                logger.debug("js syntax check for %s did not complete: %s", path, exc)
                return None

        # 0 = parsed, 1 = syntax error, anything else = the checker itself failed
        # (missing module, wrong API version) and must not be reported as the
        # agent's mistake.
        if process.returncode == 0:
            return None
        if process.returncode != 1:
            self._js_checkers[key] = None
            logger.debug(
                "disabling js syntax checks for %s: %s exited %s",
                key,
                checker.kind,
                process.returncode,
            )
            return None

        output = (stdout.decode("utf-8", "replace") + stderr.decode("utf-8", "replace")).strip()
        first = next((ln.strip() for ln in output.splitlines() if ln.strip()), "")
        return _shorten(first) or "syntax error"


def _root_of(backend: Any) -> Path | None:
    """The workspace root a JS/TS checker has to resolve ``node_modules`` from."""
    unwrap = getattr(backend, "unwrap", None)
    raw = unwrap() if callable(unwrap) else backend
    root = getattr(raw, "root_dir", None)
    return Path(root) if root is not None else None


def _shorten(message: str, limit: int = 300) -> str:
    """Keep a checker's first complaint short enough to sit in a tool result."""
    message = " ".join(message.split())
    return message if len(message) <= limit else message[: limit - 1] + "…"
