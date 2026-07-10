from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Agent, Message, Thread, Workspace
from app.db.session import get_session
from app.schemas.thread import MessageRead, ThreadCreate, ThreadRead

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


@router.get("/{thread_id}/messages", response_model=list[MessageRead])
async def list_messages(thread_id: str, session: AsyncSession = Depends(get_session)):
    if await session.get(Thread, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    result = await session.execute(
        select(Message).where(Message.thread_id == thread_id).order_by(Message.created_at)
    )
    return result.scalars().all()


@router.delete("/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_thread(thread_id: str, session: AsyncSession = Depends(get_session)):
    thread = await session.get(Thread, thread_id)
    if thread is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Thread not found")
    await session.delete(thread)
    await session.commit()
