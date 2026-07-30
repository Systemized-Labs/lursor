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


# --- spend -----------------------------------------------------------------------

USAGE = {
    "name": "lursor_usage",
    "description": (
        "Token and cost totals for Lursor's agent runs, rolled up however you ask: "
        "one grand total, per model, per workspace, or per day. Every rollup can be "
        "filtered and scoped to a date window. Use this to answer what the agents "
        "have been spending, which model or project dominates the bill, and whether "
        "usage is trending up — including how much work ran free on local models."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "group_by": {
                "type": "string",
                "enum": ["total", "model", "workspace", "day"],
                "description": "How to roll the numbers up. Defaults to 'total'.",
            },
            "days": {
                "type": "integer",
                "description": (
                    "Only count the last N days. Simpler than start/end for "
                    "'this week' style questions; ignored when start is given."
                ),
            },
            "start": {
                "type": "string",
                "description": "Earliest day to count, as YYYY-MM-DD.",
            },
            "end": {
                "type": "string",
                "description": "Latest day to count, as YYYY-MM-DD.",
            },
            "workspace": dict(
                _WORKSPACE, description=_WORKSPACE["description"] + " Optional filter."
            ),
            "model": {
                "type": "string",
                "description": "Only count runs on this exact model id.",
            },
            "kind": {
                "type": "string",
                "description": (
                    "Only count runs of this kind (e.g. 'chat', 'goal', 'cron')."
                ),
            },
        },
    },
}


# --- standing orders -------------------------------------------------------------

_SCHEDULE_ID = {
    "type": "string",
    "description": "Schedule id (see lursor_schedules).",
}

SCHEDULES = {
    "name": "lursor_schedules",
    "description": (
        "List Lursor's standing orders — agents put on a cron expression, each "
        "firing in its own timezone and opening a fresh conversation. Shows when "
        "each next fires, when it last fired, and how that last fire went. Pass a "
        "schedule_id for one schedule plus its run history, which is how you find "
        "out what an overnight run actually did."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "schedule_id": dict(
                _SCHEDULE_ID,
                description="Narrow to one schedule and include its run history.",
            ),
            "workspace": dict(
                _WORKSPACE, description=_WORKSPACE["description"] + " Optional filter."
            ),
            "limit": {
                "type": "integer",
                "description": "How many history rows to return (default 10, max 50).",
            },
        },
    },
}

CREATE_SCHEDULE = {
    "name": "lursor_create_schedule",
    "description": (
        "Put a Lursor agent on a recurring schedule. Each fire opens a fresh "
        "conversation and sends the prompt — either as a single turn, or as a full "
        "autonomous goal run. Anything due while Lursor was closed is reported, "
        "never silently replayed.\n\n"
        "The cron expression is validated before anything is created, and the "
        "result lists the next few fire times so you can check the schedule means "
        "what you intended. Use run_type='goal' for work that needs to run until "
        "it is actually done, and remember an unattended goal run's only spend "
        "bound is max_iterations."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Name for the schedule."},
            "workspace": _WORKSPACE,
            "agent": {
                "type": "string",
                "description": "Agent name or id to run each fire (see lursor_agents).",
            },
            "cron": {
                "type": "string",
                "description": (
                    "Five-field cron expression, e.g. '0 9 * * 1-5' for 9am on "
                    "weekdays."
                ),
            },
            "prompt": {
                "type": "string",
                "description": (
                    "The turn each fire sends. For run_type='goal' this doubles as "
                    "the success condition unless success_criteria is given."
                ),
            },
            "timezone": {
                "type": "string",
                "description": (
                    "IANA zone the cron is read in, e.g. 'America/New_York'. "
                    "Defaults to this machine's zone."
                ),
            },
            "run_type": {
                "type": "string",
                "enum": ["chat", "goal"],
                "description": (
                    "'chat' sends one turn; 'goal' runs autonomously until an "
                    "evaluator judges it done. Defaults to 'chat'."
                ),
            },
            "success_criteria": {
                "type": "string",
                "description": "What 'done' means for a goal fire.",
            },
            "max_iterations": {
                "type": "integer",
                "description": "Turn cap for a goal fire, 1-200 (Lursor default 25).",
            },
            "description": {
                "type": "string",
                "description": "Optional note about what this schedule is for.",
            },
        },
        "required": ["workspace", "agent", "cron", "prompt"],
    },
}

SCHEDULE_CONTROL = {
    "name": "lursor_schedule_control",
    "description": (
        "Act on an existing schedule: pause it, resume it, fire it immediately, or "
        "delete it.\n\n"
        "  run_now — fire once right away WITHOUT consuming the next slot or moving "
        "the clock. This is how you test what tonight's run will do.\n"
        "  disable — stop it firing, keep the configuration. Prefer this to delete.\n"
        "  enable  — resume a paused schedule.\n"
        "  delete  — remove it permanently; the configuration is gone and cannot be "
        "recovered. Only do this when the user has clearly asked to."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "schedule_id": _SCHEDULE_ID,
            "action": {
                "type": "string",
                "enum": ["run_now", "enable", "disable", "delete"],
                "description": "What to do with the schedule.",
            },
        },
        "required": ["schedule_id", "action"],
    },
}


# --- local models (laios) --------------------------------------------------------

_CONNECTION = {
    "type": "string",
    "description": (
        "laios connection name or id (see view='connections'). Defaults to the only "
        "one when there is just one."
    ),
}

LOCAL_MODELS = {
    "name": "lursor_local_models",
    "description": (
        "Inspect the local model daemons (laios) Lursor can drive — your own "
        "hardware rather than a cloud provider. Views:\n"
        "  connections — the daemons Lursor knows, and whether each is reachable\n"
        "  catalog     — recipes available to serve, with engine, VRAM estimate and "
        "capabilities. A recipe id is what lursor_serve_model needs.\n"
        "  models      — what is actually downloaded on disk\n"
        "  instances   — what is running right now, with status, port and endpoint\n"
        "  jobs        — in-flight model downloads with progress\n"
        "Use this before serving anything, to pick a recipe that fits the VRAM you "
        "have and to check you are not about to double-serve something."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "view": {
                "type": "string",
                "enum": ["connections", "catalog", "models", "instances", "jobs"],
                "description": "What to look at. Defaults to 'instances'.",
            },
            "connection": _CONNECTION,
            "search": {
                "type": "string",
                "description": (
                    "Filter catalog or model entries by substring — the catalog is "
                    "long, so narrow it."
                ),
            },
        },
    },
}

SERVE_MODEL = {
    "name": "lursor_serve_model",
    "description": (
        "Start or stop a local model on a laios daemon. This is what makes Hermes a "
        "capacity manager rather than just a caller: spin a model up on your own "
        "hardware, delegate work to a Lursor agent pointed at it, then free the "
        "VRAM again.\n\n"
        "Serving needs a recipe id from lursor_local_models(view='catalog'). Check "
        "the recipe's VRAM estimate against what the machine has — a too-large "
        "recipe fails slowly. Serving can take a while if the weights still need "
        "downloading; the instance comes back in a 'pulling' or 'starting' state "
        "and you should poll view='instances' rather than assume it is ready. "
        "Always stop what you started once the work is done."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["serve", "stop"],
                "description": "Start a recipe, or stop a running instance.",
            },
            "connection": _CONNECTION,
            "recipe": {
                "type": "string",
                "description": "Recipe id to serve (required for action='serve').",
            },
            "instance_id": {
                "type": "string",
                "description": "Instance to stop (required for action='stop').",
            },
            "max_model_len": {
                "type": "integer",
                "description": "Override the recipe's context length.",
            },
            "served_name": {
                "type": "string",
                "description": "Name the model is served under.",
            },
            "port": {"type": "integer", "description": "Override the serving port."},
            "gpu_memory_utilization": {
                "type": "number",
                "description": "Fraction of VRAM the engine may take, e.g. 0.9.",
            },
            "solo": {
                "type": "boolean",
                "description": "Stop other instances first so this one runs alone.",
            },
        },
        "required": ["action"],
    },
}


# --- github ----------------------------------------------------------------------

GITHUB = {
    "name": "lursor_github",
    "description": (
        "Work with the GitHub account connected to Lursor.\n"
        "  repos — list repositories the account can reach, newest activity first\n"
        "  clone — clone one into a brand-new Lursor workspace, ready to delegate "
        "against immediately\n"
        "Cloning creates a workspace, so it changes state: only clone when asked. "
        "It refuses to clone into a directory that already has anything in it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["repos", "clone"],
                "description": "List repositories, or clone one.",
            },
            "repo": {
                "type": "string",
                "description": (
                    "Repository as 'owner/name' (for action='clone'). A full "
                    "clone_url works too."
                ),
            },
            "name": {
                "type": "string",
                "description": "Workspace name. Defaults to the repository name.",
            },
            "path": {
                "type": "string",
                "description": (
                    "Absolute directory to clone into. Must be empty or absent. "
                    "Defaults to a fresh directory under Lursor's workspaces root."
                ),
            },
            "search": {
                "type": "string",
                "description": "Filter the repo listing by substring.",
            },
            "limit": {
                "type": "integer",
                "description": "How many repos to return (default 30, max 100).",
            },
        },
        "required": ["action"],
    },
}
