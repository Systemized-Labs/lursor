"""A/B the one-shot timeout split against the live lastway relay.

Sends the *same* non-streaming request twice through Lursor's own client
factories, differing only in which timeout regime built the client:

  streaming client (read=model_stream_stall_timeout) -- the old behaviour
  one-shot client  (read=one_shot_request_timeout)   -- the fix

The request is sized to generate for longer than the stall timeout, so the
first must fail with ReadTimeout and the second must succeed. That is the
production bug and its fix, end to end, against real infrastructure.

Not part of the test suite: it costs several minutes of real GPU time and
depends on a reachable relay. Run it by hand.
"""

from __future__ import annotations

import asyncio
import time

import httpx
from sqlalchemy import select

from app.agents.builder import _shared_local_http_client
from app.config import get_settings
from app.db.models import CustomProvider
from app.db.session import async_session_factory

MODEL = "glm-5.2-quanttrio"  # slowest of the fleet
# ~19 tok/s sustained (a short calibration run reads lower, because fixed
# prefill overhead dominates it), so ~9000 tokens is ~465s of generation --
# past the 300s stall ceiling and well inside the 900s one-shot budget.
MAX_TOKENS = 9000
PROMPT = "Count from 1 to 6000, one number per line. Do not stop early."


async def _attempt(label: str, *, streaming: bool, provider: CustomProvider) -> float:
    """One non-streaming call on the client built for `streaming`."""
    client = _shared_local_http_client(streaming=streaming)
    read = client.timeout.read
    print(f"\n[{label}] read timeout = {read}s -- sending...", flush=True)

    started = time.monotonic()
    try:
        response = await client.post(
            f"{provider.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {provider.api_key}"},
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": PROMPT}],
                "max_tokens": MAX_TOKENS,
                "stream": False,
            },
        )
    except httpx.ReadTimeout:
        elapsed = time.monotonic() - started
        print(f"[{label}] ReadTimeout after {elapsed:.1f}s (ceiling was {read}s)")
        return elapsed

    elapsed = time.monotonic() - started
    usage = response.json().get("usage", {})
    print(
        f"[{label}] HTTP {response.status_code} after {elapsed:.1f}s, "
        f"completion_tokens={usage.get('completion_tokens')}"
    )
    return elapsed


async def main() -> None:
    settings = get_settings()
    print(
        f"stall={settings.model_stream_stall_timeout}s  "
        f"one_shot={settings.one_shot_request_timeout}s  "
        f"model={MODEL}  max_tokens={MAX_TOKENS}"
    )

    async with async_session_factory() as db:
        rows = (await db.execute(select(CustomProvider))).scalars()
        provider = next(p for p in rows if p.name == "lastway")
    print(f"relay: {provider.base_url}")

    # Sequentially: concurrent runs would contend on the same GPU and distort
    # both timings.
    old = await _attempt("OLD streaming client", streaming=True, provider=provider)
    new = await _attempt("NEW one-shot client", streaming=False, provider=provider)

    print("\n--- verdict ---")
    ok_old = abs(old - settings.model_stream_stall_timeout) < 15
    ok_new = new > settings.model_stream_stall_timeout
    print(f"old client aborted at the stall ceiling: {ok_old} ({old:.1f}s)")
    print(f"new client outlived the stall ceiling:   {ok_new} ({new:.1f}s)")
    print("RESULT:", "PASS" if (ok_old and ok_new) else "INCONCLUSIVE")


if __name__ == "__main__":
    asyncio.run(main())
