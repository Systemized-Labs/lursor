"""Let a remote backend replace itself, from the UI.

The desktop app updates itself through electron-updater, and a packaged app carries
its backend inside its own bundle — so for a local install this whole surface is
inert and says so. It exists for the *remote* case: a backend installed by
``scripts/install-server.sh`` onto a machine that stays on, where the client can
reach it but the operator would otherwise have to SSH in and ``git pull``.

Three things make this different from an ordinary POST:

1. **The reply may never arrive.** The job restarts the service, which kills the
   process holding the connection. A transport error immediately after ``POST
   /update`` means the update started, not that it failed. ``api/laios.py`` hit the
   same wall proxying daemon restarts and settled on the same reading.
2. **Progress outlives the process.** Nothing in memory survives, so the job writes
   to a log and a state file under the data directory (``app/updater.py``) and the
   client polls them back once it reconnects.
3. **It runs code on the host.** The gates are in ``updater.self_update_blocker()``
   and every one of them must pass; see ``SECURITY.md``.

The expensive checks live here rather than in ``updater.py`` because they need the
event loop: a GitHub round trip and a ``git fetch``, neither of which belongs on
``/api/server-info``.
"""

from __future__ import annotations

import asyncio
import subprocess
import time

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app import updater

router = APIRouter(prefix="/update", tags=["update"])

# Long enough for a cold GitHub response, short enough that a hung check doesn't
# hold a request open — the UI treats a failed check as "unknown", not an error.
_CHECK_TIMEOUT = httpx.Timeout(15.0)
_CACHE_TTL = 600.0

# ``(repo, monotonic_at, tag, error)`` for the last release lookup. Process-local and
# deliberately not a real cache: one entry, no eviction, lost on restart.
_latest_cache: tuple[str, float, str | None, str | None] | None = None


class UpdateCheck(BaseModel):
    current: str
    latest: str | None = None
    update_available: bool = False
    # Why the check couldn't be completed, when it couldn't. Not an HTTP error: a
    # backend with no outbound network is a normal, recoverable state and the UI
    # should keep showing the version it already knows.
    error: str | None = None


def _is_newer(candidate: str, current: str) -> bool:
    """Dotted numeric compare, prerelease ranking below the release it leads to.

    Mirrors ``isNewerVersion`` in ``frontend/electron/main.cjs`` — the same rule has
    to hold on both sides or the client and the backend disagree about whether an
    update exists. Kept small and total: anything unparseable compares as zero
    rather than raising, because a malformed tag upstream must not break the check.
    """

    def parse(value: str) -> tuple[list[int], str]:
        v = (value or "").strip().lstrip("v")
        base, _, pre = v.partition("-")
        nums = []
        for part in base.split("."):
            try:
                nums.append(int(part))
            except ValueError:
                nums.append(0)
        return nums, pre

    a_nums, a_pre = parse(candidate)
    b_nums, b_pre = parse(current)
    for i in range(max(len(a_nums), len(b_nums))):
        x = a_nums[i] if i < len(a_nums) else 0
        y = b_nums[i] if i < len(b_nums) else 0
        if x != y:
            return x > y
    if a_pre == b_pre:
        return False
    if not a_pre:
        return True
    if not b_pre:
        return False
    return a_pre > b_pre


async def _latest_release(repo: str) -> str:
    """The newest stable release tag.

    ``/releases/latest`` is the endpoint that already excludes drafts and
    prereleases, which is exactly the "stable only" channel we want — no filtering
    of our own to get wrong.
    """
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    # ``follow_redirects`` is not optional here, and not merely defensive: the default
    # repo has been renamed, so GitHub answers a 301 to the new owner. httpx does not
    # follow redirects by default (unlike ``fetch``, which is why the Electron-side
    # check never hit this), so without it every check fails with a bare 301 for
    # everyone on the default repo.
    async with httpx.AsyncClient(timeout=_CHECK_TIMEOUT, follow_redirects=True) as client:
        res = await client.get(url, headers={"Accept": "application/vnd.github+json"})
        res.raise_for_status()
        return str(res.json().get("tag_name") or "").lstrip("v")


@router.get("/status")
async def update_status() -> dict[str, object]:
    """What this backend is and how the last update went. Local, no network.

    Safe to poll: everything it reports is a file read or an env lookup.
    """
    return updater.status()


async def _cached_latest(repo: str) -> tuple[str | None, str | None]:
    """``(tag, error)``, memoised briefly.

    Unauthenticated GitHub allows 60 requests an hour per IP, shared with everything
    else on the host. The check is on-demand rather than polled, but a UI that
    refetches on window focus plus an impatient operator is enough to matter, so
    hold the answer for a few minutes.
    """
    global _latest_cache
    now = time.monotonic()
    if _latest_cache and _latest_cache[0] == repo and now - _latest_cache[1] < _CACHE_TTL:
        return _latest_cache[2], _latest_cache[3]

    tag: str | None = None
    error: str | None = None
    try:
        tag = await _latest_release(repo) or None
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        error = f"Could not reach GitHub: {exc}"
    _latest_cache = (repo, now, tag, error)
    return tag, error


@router.get("/check", response_model=UpdateCheck)
async def update_check() -> UpdateCheck:
    """Ask GitHub whether there is a newer release.

    Deliberately not folded into ``/status`` and not polled on a timer — it is a
    network round trip per call. ``api/laios.py``'s ``?check=true`` split the same
    way, for the same reason.

    Compares release tags only. Counting commits behind ``main`` was considered and
    dropped: the channel is stable-releases-only, so a commit count answers a
    question nobody asked and would report "behind" on a host sitting exactly on the
    newest release.
    """
    current = updater.status()["version"]
    assert isinstance(current, str)

    latest, error = await _cached_latest(updater.update_repo())
    if error is not None:
        return UpdateCheck(current=current, error=error)

    return UpdateCheck(
        current=current,
        latest=latest,
        update_available=bool(latest) and _is_newer(latest, current),
    )


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def start_update() -> dict[str, object]:
    """Start the self-update and return immediately.

    202, not 200: the work has been accepted, not finished. Expect this connection
    to drop moments later when the service restarts — that is success. Poll
    ``/update/status`` and ``/update/log`` after reconnecting.
    """
    blocker = updater.self_update_blocker()
    if blocker is not None:
        # 409, not 403: nothing about the caller is wrong, the host is simply not in
        # a state where this can be done. The reason is the actionable part.
        #
        # Note this is also the gate that closes a real hole rather than a
        # theoretical one. CORS here reflects any origin (``main.py``) and
        # ``TokenAuthMiddleware`` is only installed when a token is set, so on a
        # tokenless loopback backend any page in the user's browser could POST here.
        # ``self_update_blocker`` requires a token, so that case can never start a
        # job. See SECURITY.md.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=blocker)

    if updater.is_update_running():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An update is already running on this host.",
        )

    # Resolve what to move to before spawning anything, so a GitHub outage fails the
    # request cleanly instead of starting a job that can't decide where to go.
    target = updater.pinned_ref()
    if target is None:
        latest, error = await _cached_latest(updater.update_repo())
        if not latest:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=error or "Could not resolve the latest release to update to.",
            )
        target = f"v{latest}"

    try:
        state = await asyncio.to_thread(updater.start_update, target)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not start the update: {exc}",
        ) from exc

    return {"started": True, "state": state}


@router.get("/log")
async def update_log(tail: int = Query(default=200, ge=1, le=5000)) -> dict[str, object]:
    """The tail of the update log, so the UI can follow a job across the restart."""
    return {"log": updater.read_log(tail), "state": updater.read_state()}
