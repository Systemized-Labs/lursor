"""A stable identity for a long-running command, inferred from the command itself.

The problem this solves: a dev server has no name. It is spawned as
``run_in_background("npm run dev")`` and tracked by a spawn counter
(``bg_3``), so nothing in the system can say "this is the frontend dev server for
this project" — only "this is the third background process of this backend". Every
layer therefore re-derives identity its own way, and the one that guards against
duplicates compared raw command strings. A model that spells the same server three
ways across three turns gets three servers:

    npm run dev
    cd frontend && npm run dev
    npm run dev --prefix frontend

The last two are the *same server*; the first is a different one (the root package,
not the frontend package). Raw string comparison gets all three wrong.

So identity is inferred here, from the two things that actually distinguish one
long-running service from another:

**The directory it runs in.** A monorepo's ``frontend`` and ``api`` dev servers are
different services; two spellings of ``frontend``'s are not. ``cd X &&`` and the
``--prefix``/``--cwd``/``-C`` flags all express the same thing, so they are parsed
out of the command and into the key. (The backend always spawns with ``cwd`` set to
the workspace root, so the effective directory is only ever visible in the command
text — there is nothing else to read it from.)

**The program.** ``npm run dev`` and ``uvicorn app:main`` in one directory are two
legitimate servers, and neither should displace the other.

Two keys are derived, because prevention and reconciliation want different
strictness:

:func:`spawn_key` is exact — it keeps flags. Used before spawning, where reusing a
process for a byte-identical command is safe but silently ignoring a caller who
asked for ``--port 3001`` is not.

:func:`service_key` additionally drops a pinned port, so ``npm run dev`` and
``npm run dev -- --port 3001`` collapse. Used *after* the fact, once both are
observed serving HTTP, to retire the one a newer process replaced. This is the key
that catches the auto-increment case: a second dev server on a taken port does not
fail, it quietly moves to 3001, which is exactly why the duplicates all stay alive.

Inference is deliberately conservative. Every rule here recognises a spelling of
the *same* command; none tries to decide that two different commands are the same
service. A missed match leaves today's behaviour (two entries, as now); a wrong
match would kill a server someone is using.
"""

from __future__ import annotations

import re

# Pure file-descriptor redirections with no filename target (``2>&1``, ``1>&2``,
# ``>&1`` …). Dropping these means ``npm run dev`` and ``npm run dev 2>&1`` are one
# service rather than two.
_FD_REDIRECT = re.compile(r"\s*\d*>&\d+")

# A quoted-or-bare path argument.
_PATH = r"'[^']*'|\"[^\"]*\"|[^\s;&|]+"

# A leading ``cd <dir> &&``, optionally wrapped in a subshell — by far the most
# common way a model points a command at a subdirectory.
_LEADING_CD = re.compile(rf"^\(?\s*cd\s+(?P<dir>{_PATH})\s*&&\s*")
# The `)` closing a `(cd x && …)` subshell, once the `cd` has been taken off.
_DANGLING_PAREN = re.compile(r"\)\s*$")

# ``--prefix <dir>`` (npm), ``--cwd <dir>`` (yarn/vite), ``-C <dir>`` (make/git).
# The same intent as a leading ``cd``, expressed as a flag.
_PREFIX_FLAG = re.compile(rf"\s(?:--prefix|--cwd)[=\s]+(?P<dir>{_PATH})")
_C_FLAG = re.compile(rf"\s-C[=\s]+(?P<dir>{_PATH})")

# A pinned port, in the spellings a dev server accepts. Stripped only for
# :func:`service_key` — see the module docstring.
_PORT_FLAG = re.compile(r"\s(?:--port|-p)[=\s]+\d{2,5}\b")
_PORT_ENV = re.compile(r"^PORT=\d{2,5}\s+")
# What ``-- --port 3001`` leaves behind once the port is gone.
_DANGLING_SEPARATOR = re.compile(r"\s--\s*$")

# Joins the two halves of a key. A NUL can't occur in either, so no directory
# ending in the separator can collide with a command beginning with one.
_SEP = "\x00"


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _normalize_dir(raw: str) -> str:
    """Reduce a directory argument to a comparable form.

    ``./frontend/``, ``frontend`` and ``"frontend"`` are one directory; ``.`` and
    the empty string both mean "the workspace root" and normalize to ``""``.
    """
    cleaned = _unquote(raw).strip()
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    cleaned = cleaned.rstrip("/")
    return "" if cleaned in {".", ""} else cleaned


def canonical(command: str) -> tuple[str, str]:
    """Split ``command`` into ``(effective directory, the command without it)``.

    The directory is whatever the command navigates to before running — via a
    leading ``cd``, or a ``--prefix``/``--cwd``/``-C`` flag — normalized, and
    removed from the returned command so both spellings produce the same pair.
    ``""`` means the workspace root.
    """
    text = _FD_REDIRECT.sub("", command)
    text = re.sub(r"\s+", " ", text).strip()

    workdir = ""
    cd_match = _LEADING_CD.match(text)
    if cd_match is not None:
        workdir = _normalize_dir(cd_match.group("dir"))
        # A subshell's closing paren belongs to the `cd`, not to the command.
        text = _DANGLING_PAREN.sub("", text[cd_match.end() :]).strip()

    for pattern in (_PREFIX_FLAG, _C_FLAG):
        flag_match = pattern.search(text)
        if flag_match is None:
            continue
        # A `cd` already established the directory; the flag is then redundant
        # rather than authoritative, but still has to leave the command text so
        # the two spellings compare equal.
        if not workdir:
            workdir = _normalize_dir(flag_match.group("dir"))
        text = (text[: flag_match.start()] + text[flag_match.end() :]).strip()

    return workdir, text


def _key(workdir: str, command: str) -> str:
    return f"{workdir}{_SEP}{command}" if workdir else command


def spawn_key(command: str) -> str:
    """Identity for "is this exact command already running?".

    Flags are preserved, so a caller asking for different behaviour (a specific
    port, a different mode) still gets its own process.
    """
    return _key(*canonical(command))


def service_key(command: str) -> str:
    """Identity for "which service does this process provide?".

    Coarser than :func:`spawn_key`: a pinned port is dropped, so the same server
    started twice — the second having landed on another port, by request or by
    auto-increment — resolves to one service.
    """
    workdir, text = canonical(command)
    text = _PORT_ENV.sub("", _PORT_FLAG.sub("", text))
    text = _DANGLING_SEPARATOR.sub("", text).strip()
    return _key(workdir, text)
