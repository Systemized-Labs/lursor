"""The Assistant — Lursor's top-level, app-owned control-plane agent.

Every other agent in Lursor is a peer: a DB row scoped to one workspace with the
same deep-agent toolset. The Assistant is the one that operates *Lursor itself* —
it creates workspaces, retargets other agents' models, manages schedules, starts
runs and reads the bill.

The package boundary is the security boundary. Nothing under ``app/agents/`` may
import from here except :mod:`app.assistant.registry`, which is a leaf holding
the privileged name set and the guard that enforces it. Everything else here
imports freely in the other direction.

Layout:

- :mod:`.identity`  — the two seeded system rows, and how to recognise them
- :mod:`.registry`  — ``ASSISTANT_TOOL_NAMES`` and ``AssistantToolGuard``
- :mod:`.tools`     — the control-plane tools
- :mod:`.confirm`   — the in-chat confirmation protocol for destructive actions
- :mod:`.prompt`    — the system prompt constant
- :mod:`.builder`   — ``build_assistant_context``, the one branch off ``api/chat.py``

Deliberately no eager re-exports: ``registry`` must stay importable without
dragging in ``tools`` (which imports the API layer, which imports the builder,
which imports ``registry``). Import the submodule you need.
"""

from __future__ import annotations
