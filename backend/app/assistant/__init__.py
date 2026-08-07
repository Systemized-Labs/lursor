"""The Assistant — Lursor's control plane, scoped to one workspace.

Agents in Lursor are peers: a row, a toolset, no privileges. What this package
adds is a *place* where an agent can also operate Lursor itself — create
workspaces, retarget other agents' models, manage schedules, start runs, read the
bill. Any agent you select in the Assistant workspace gets that toolset for the
run; the same agent in one of your projects does not.

Entitlement is therefore a property of the workspace, and the whole of it is
:func:`app.assistant.identity.is_assistant_workspace`, called once per build in
``api/chat.py``. There is no privileged agent row, no name to protect and no flag
to keep in sync — which is deliberate, because every one of those would have been
a second place for the answer to "may this run hold the control plane?" to live.

The package boundary is the security boundary. Nothing under ``app/agents/`` may
import from here except :mod:`app.assistant.registry`, which is a leaf holding
the privileged name set, the guard that enforces it, and the prompt that travels
with it. Everything else here imports freely in the other direction.

Layout:

- :mod:`.identity`  — the seeded workspace, its starter agent, and the predicate
- :mod:`.registry`  — ``ASSISTANT_TOOL_NAMES``, ``AssistantToolGuard``, the rules
- :mod:`.tools`     — the control-plane tools
- :mod:`.confirm`   — the in-chat confirmation protocol for destructive actions

Deliberately no eager re-exports: ``registry`` must stay importable without
dragging in ``tools``, which imports the API layer, which imports ``registry``.
Import the submodule you need.
"""

from __future__ import annotations
