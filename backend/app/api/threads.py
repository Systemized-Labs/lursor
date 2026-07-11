from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents.chat_run_manager import chat_run_manager
from app.db.models import Agent, Message, Thread, Workspace
from app.db.session import get_session
from app.media_store import MEDIA_ID_RE, media_path, mime_for_path
from app.schemas.thread import MessageRead, ThreadCreate, ThreadRead, ThreadUpdate

router = APIRouter(prefix="/threads", tags=["threads"])


@router.get("", response_model=list[ThreadRead])
async def list_threads(
    workspace_id: str | None = None, session: AsyncSession = Depends(get_session)
):
    query = select(Thread).order_by(Thread.created_at.desc())
    if workspace_id:
        query = query.where(Thread.workspace_id == workspace_id)
    result = await session.execute(query)
    return result.scalars().all()


# Declared before "/{thread_id}" so the literal path is matched first.
@router.get("/active-runs", response_model=list[str])
async def list_active_runs() -> list[str]:
    """Thread ids with a live background chat run (drives the UI's running badges)."""
    return chat_run_manager.active_threads()


@router.post("", response_model=ThreadRead, status_code=status.HTTP_201_CREATED)
async def create_thread(payload: ThreadCreate, session: AsyncSession = Depends(get_session)):
    if await session.get(Workspace, payload.workspace_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown workspace_id")
    if await session.get(Agent, payload.agent_id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown agent_id")
    thread = Thread(**payload.model_dump())
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    return thread


@router.get("/{thread_id}", response_model=ThreadRead)
async def get_thread(thread_id: str, session: AsyncSession = Depends(get_session)):
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    return thread


@router.patch("/{thread_id}", response_model=ThreadRead)
async def update_thread(
    thread_id: str, payload: ThreadUpdate, session: AsyncSession = Depends(get_session)
):
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")

    if payload.agent_id is not None:
        if await session.get(Agent, payload.agent_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown agent_id")
        thread.agent_id = payload.agent_id
    if payload.title is not None:
        thread.title = payload.title

    thread.updated_at = datetime.now(UTC)
    session.add(thread)
    await session.commit()
    await session.refresh(thread)
    return thread


@router.get("/{thread_id}/messages", response_model=list[MessageRead])
async def list_messages(thread_id: str, session: AsyncSession = Depends(get_session)):
    if await session.get(Thread, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    result = await session.execute(
        select(Message).where(Message.thread_id == thread_id).order_by(Message.created_at)
    )
    return result.scalars().all()


@router.get("/{thread_id}/media/{media_id}")
async def get_media(thread_id: str, media_id: str) -> FileResponse:
    """Serve a stored attachment inline. ``media_id`` is regex-checked so it
    cannot escape the thread's media folder."""
    if not MEDIA_ID_RE.match(media_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid media id")
    path = media_path(thread_id, media_id)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    return FileResponse(
        path, media_type=mime_for_path(path), headers={"Cache-Control": "max-age=31536000"}
    )


@router.delete("/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_thread(thread_id: str, session: AsyncSession = Depends(get_session)):
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    await session.delete(thread)
    await session.commit()
