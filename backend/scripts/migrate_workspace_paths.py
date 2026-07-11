"""Rename id-based workspace folders to friendly slug-based ones.

Workspaces created before the slug change live at ``<workspaces_dir>/<uuid-hex>``.
This script renames each such folder to a slug of its name (deduped on collision)
and updates the stored ``path`` in the database. Custom paths (anything not a
32-char hex folder directly under the workspaces root) are left untouched.

Idempotent: already-migrated workspaces are skipped. Dry-run by default.

    uv run python -m scripts.migrate_workspace_paths          # preview only
    uv run python -m scripts.migrate_workspace_paths --apply  # perform renames
"""

import asyncio
import re
import sys
from pathlib import Path

from sqlmodel import select

from app.config import get_settings
from app.db.models import Workspace
from app.db.session import async_session_factory, init_db
from app.workspace_paths import unique_workspace_dir

_HEX_ID_RE = re.compile(r"^[0-9a-f]{32}$")


async def main(apply: bool) -> None:
    settings = get_settings()
    root = settings.workspaces_dir.resolve()

    await init_db()
    async with async_session_factory() as session:
        workspaces = (await session.execute(select(Workspace))).scalars().all()

        migrated = 0
        for ws in workspaces:
            current = Path(ws.path)
            # Only touch id-named folders that live directly under the root.
            if current.parent.resolve() != root or not _HEX_ID_RE.match(current.name):
                continue

            target = unique_workspace_dir(root, ws.name)
            if not current.exists():
                # Folder is gone; just repoint the DB record so it materializes
                # under the friendly name next time it is used.
                print(f"  [missing] {ws.name}: {current.name} -> {target.name} (db only)")
                if apply:
                    ws.path = str(target)
                    session.add(ws)
                migrated += 1
                continue

            print(f"  {ws.name}: {current.name} -> {target.name}")
            if apply:
                current.rename(target)
                ws.path = str(target)
                session.add(ws)
            migrated += 1

        if apply:
            await session.commit()
            print(f"\nMigrated {migrated} workspace(s).")
        else:
            print(f"\n{migrated} workspace(s) would be migrated. Re-run with --apply.")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
