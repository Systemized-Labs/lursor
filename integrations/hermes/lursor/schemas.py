"""Tool schemas — what Hermes's model sees when deciding to reach for Lursor.

These descriptions are the whole interface as far as the model is concerned, so
they say when *not* to use a tool as much as when to: the point of delegating to
Lursor is work that wants a persistent workspace, a long autonomous run, or a
different model than the one Hermes is on — not a file read Hermes could do
itself in one step.
"""

_WORKSPACE = {
    "type": "string",
    "description": (
        "Workspace name or id (see lursor_workspaces). A partial name works when "
        "it matches exactly one."
    ),
}

WORKSPACES = {
    "name": "lursor_workspaces",
    "description": (
        "List the workspaces in the local Lursor instance: each one is a real "
        "directory on this machine that Lursor agents work inside. Returns id, "
        "name and absolute path. Start here when you need to pick a workspace to "
        "delegate work into, or to learn where a project lives on disk."
    ),
    "parameters": {"type": "object", "properties": {}},
}

AGENTS = {
    "name": "lursor_agents",
    "description": (
        "List the agents configured in Lursor, with the model each one runs and "
        "which capabilities it has (subagents, skills, memory, web search, "
        "thinking level). Use this to choose the right agent before delegating — "
        "agents differ in model and in what they are allowed to do."
    ),
    "parameters": {"type": "object", "properties": {}},
}

DELEGATE = {
    "name": "lursor_delegate",
    "description": (
        "Hand a piece of work to a Lursor agent running in one of its workspaces, "
        "and get the agent's reply back. This is the main reason to use Lursor: "
        "the agent has a real shell, filesystem and git working tree in that "
        "directory, keeps running even if nothing is watching, and can work "
        "autonomously for many turns.\n\n"
        "Pick the turn type:\n"
        "  chat  — one ordinary turn with full tools (the default).\n"
        "  ask   — one read-only turn; the agent inspects but changes nothing.\n"
        "  goal  — an autonomous run: the agent works turn after turn until an "
        "independent evaluator judges the objective met, or it hits its "
        "iteration cap. Your message IS the success condition, so write it as "
        "one ('the test suite passes and lint is clean'), not as a chat opener.\n"
        "  plan  — draft a plan document and stop for review, without executing.\n"
        "  execute_plan — carry out the plan a previous 'plan' turn parked on "
        "this conversation (requires thread_id).\n\n"
        "Pass thread_id to continue an existing conversation with its history "
        "intact; omit it to open a new one. Goal runs default to not waiting "
        "(they can take many minutes) — poll them with lursor_run_status. Do not "
        "use this for something you can do yourself in a step or two."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": (
                    "What to send the agent. For turn='goal' this is the success "
                    "condition the run is judged against."
                ),
            },
            "workspace": _WORKSPACE,
            "agent": {
                "type": "string",
                "description": (
                    "Agent name or id to run the turn (see lursor_agents). "
                    "Defaults to the conversation's own agent when continuing, or "
                    "the only configured agent when there is just one."
                ),
            },
            "thread_id": {
                "type": "string",
                "description": (
                    "Continue this existing conversation instead of opening a new "
                    "one. Its prior messages are resent so the agent keeps full "
                    "context."
                ),
            },
            "turn": {
                "type": "string",
                "enum": ["chat", "ask", "goal", "plan", "execute_plan"],
                "description": "How to run the turn. Defaults to 'chat'.",
            },
            "title": {
                "type": "string",
                "description": "Title for a newly opened conversation.",
            },
            "wait": {
                "type": "boolean",
                "description": (
                    "Block until the run finishes and return the reply. Defaults "
                    "to true for chat/ask/plan and false for goal/execute_plan. "
                    "When false, returns a thread_id to poll."
                ),
            },
            "timeout_seconds": {
                "type": "integer",
                "description": (
                    "How long to wait when wait=true (default 180, max 900). On "
                    "timeout the run keeps going — the result says so and you can "
                    "poll it."
                ),
            },
            "max_iterations": {
                "type": "integer",
                "description": (
                    "Turn cap for a goal run on a new conversation (Lursor's "
                    "default is 25)."
                ),
            },
        },
        "required": ["message"],
    },
}

RUN_STATUS = {
    "name": "lursor_run_status",
    "description": (
        "Check whether a Lursor conversation still has a run in flight, and read "
        "the newest assistant message. Use this to follow up a lursor_delegate "
        "call that did not wait, or one that timed out while the agent kept "
        "working. For a goal run it also reports the iteration count and why the "
        "run stopped."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "thread_id": {
                "type": "string",
                "description": "Conversation id returned by lursor_delegate.",
            }
        },
        "required": ["thread_id"],
    },
}

STOP_RUN = {
    "name": "lursor_stop_run",
    "description": (
        "Stop the run in flight on a Lursor conversation. Work already written to "
        "disk stays; the partial reply is kept in the transcript. Use this when a "
        "delegated run is going the wrong way."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "thread_id": {
                "type": "string",
                "description": "Conversation id whose run should be stopped.",
            }
        },
        "required": ["thread_id"],
    },
}

THREADS = {
    "name": "lursor_threads",
    "description": (
        "List Lursor conversations, newest first, with their workspace, agent, "
        "status and whether a run is currently in flight. Use it to find a "
        "conversation worth resuming instead of starting a fresh one."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "workspace": dict(
                _WORKSPACE, description=_WORKSPACE["description"] + " Optional filter."
            ),
            "limit": {
                "type": "integer",
                "description": "How many to return (default 20, max 100).",
            },
        },
    },
}

MESSAGES = {
    "name": "lursor_messages",
    "description": (
        "Read the transcript of a Lursor conversation: who said what, and which "
        "tools the agent called. Use it to see how an agent reached its result, "
        "or to catch up on a conversation you did not start."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "thread_id": {"type": "string", "description": "Conversation id."},
            "limit": {
                "type": "integer",
                "description": "Most recent N messages (default 20, max 100).",
            },
        },
        "required": ["thread_id"],
    },
}

DIFF = {
    "name": "lursor_diff",
    "description": (
        "Show the uncommitted git changes across every repo under a Lursor "
        "workspace: branch, changed files, and added/deleted line counts. This is "
        "how you verify what a delegated agent actually changed. Returns a "
        "summary by default; set include_patch to read the diff text itself."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "workspace": _WORKSPACE,
            "include_patch": {
                "type": "boolean",
                "description": (
                    "Include unified diff text per file (default false — patches "
                    "are large and get truncated)."
                ),
            },
            "path": {
                "type": "string",
                "description": "Only report this workspace-relative file path.",
            },
        },
        "required": ["workspace"],
    },
}

LIST_FILES = {
    "name": "lursor_list_files",
    "description": (
        "List the immediate children of a directory inside a Lursor workspace "
        "(directories first). Noise directories such as node_modules are omitted. "
        "Use it to find your way around a workspace before reading a file."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "workspace": _WORKSPACE,
            "path": {
                "type": "string",
                "description": (
                    "Workspace-relative directory. Omit for the workspace root."
                ),
            },
        },
        "required": ["workspace"],
    },
}

READ_FILE = {
    "name": "lursor_read_file",
    "description": (
        "Read a text file from inside a Lursor workspace. Paths are relative to "
        "the workspace root and cannot escape it. Binary and oversize files come "
        "back flagged rather than as content."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "workspace": _WORKSPACE,
            "path": {
                "type": "string",
                "description": "Workspace-relative file path.",
            },
        },
        "required": ["workspace", "path"],
    },
}
