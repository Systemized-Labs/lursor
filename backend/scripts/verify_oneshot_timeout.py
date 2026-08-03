"""A/B the one-shot timeout split against the live lastway relay.

Sends the *same* non-streaming request twice through Lursor's own client
factories, differing only in which timeout regime built the client. The point
is the mechanism: on a non-streaming call there is no chunk to reset on, so the
read timeout is the total budget and a generation that outlives it is killed
client-side with zero bytes received -- which is the production bug.

Rather than engineering a >300s generation (the fleet's speculative decoding
outruns it -- a predictable prompt accelerates to 30+ tok/s), this scales the
*settings* down around a short real request and drives the genuine
`_shared_local_http_client` factories. Same code path and same relay, seconds
instead of minutes:

  stall regime    -> read below the generation time  -> must ReadTimeout
  one-shot regime -> read above the generation time  -> must succeed

The absolute 300/900 values are settings, verified separately; what needs
proving against real infrastructure is that the regime a caller gets decides
whether a slow one-shot call survives.

Not part of the test suite: it depends on a reachable relay. Run it by hand.
"""

from __future__ import annotations

import asyncio
import time

import httpx
from sqlalchemy import select

from app.agents import builder
from app.config import get_settings
from app.db.models import CustomProvider
from app.db.session import async_session_factory

MODEL = "glm-5.2-quanttrio"
CALIBRATE_TOKENS = 1200
PROMPT = "Count from 1 to 6000, one number per line. Do not stop early."


def _reset_client_cache() -> None:
    """Force the factories to rebuild against the current settings."""
    builder._local_http_clients.clear()


async def _call(client: httpx.AsyncClient, provider: CustomProvider) -> tuple[str, float]:
    """Return (outcome, elapsed) for one non-streaming request."""
    started = time.monotonic()
    try:
        response = await client.post(
            f"{provider.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {provider.api_key}"},
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": PROMPT}],
                "max_tokens": CALIBRATE_TOKENS,
                "stream": False,
            },
        )
    except httpx.ReadTimeout:
        return "read_timeout", time.monotonic() - started
    outcome = "ok" if response.status_code == 200 else f"http_{response.status_code}"
    return outcome, time.monotonic() - started


async def main() -> None:
    settings = get_settings()
    async with async_session_factory() as db:
        rows = (await db.execute(select(CustomProvider))).scalars()
        provider = next(p for p in rows if p.name == "lastway")
    print(f"relay: {provider.base_url}  model: {MODEL}")

    # 1. Measure how long this request actually takes, with both ceilings high.
    settings.model_stream_stall_timeout = 600.0
    settings.one_shot_request_timeout = 600.0
    _reset_client_cache()
    outcome, baseline = await _call(builder._shared_local_http_client(streaming=False), provider)
    if outcome != "ok":
        print(f"calibration failed ({outcome}) -- relay or model unavailable")
        return
    print(f"baseline: {CALIBRATE_TOKENS} tokens in {baseline:.1f}s")

    # 2. Straddle it: the stall ceiling below, the one-shot budget above.
    settings.model_stream_stall_timeout = round(baseline / 3, 1)
    settings.one_shot_request_timeout = round(baseline * 4, 1)
    _reset_client_cache()
    print(
        f"\nstall={settings.model_stream_stall_timeout}s (below) "
        f"one_shot={settings.one_shot_request_timeout}s (above)"
    )

    streaming_client = builder._shared_local_http_client(streaming=True)
    oneshot_client = builder._shared_local_http_client(streaming=False)
    assert streaming_client is not oneshot_client

    old_outcome, old_elapsed = await _call(streaming_client, provider)
    print(f"[stall regime]    {old_outcome} after {old_elapsed:.1f}s")
    new_outcome, new_elapsed = await _call(oneshot_client, provider)
    print(f"[one-shot regime] {new_outcome} after {new_elapsed:.1f}s")

    print("\n--- verdict ---")
    ok_old = old_outcome == "read_timeout"
    ok_new = new_outcome == "ok" and new_elapsed > settings.model_stream_stall_timeout
    print(f"stall regime killed the call:            {ok_old} ({old_outcome})")
    print(f"one-shot regime carried it to completion: {ok_new} ({new_outcome})")
    print("RESULT:", "PASS" if (ok_old and ok_new) else "FAIL")


if __name__ == "__main__":
    asyncio.run(main())
