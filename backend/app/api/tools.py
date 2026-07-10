from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db.models import Tool
from app.db.session import get_session
from app.schemas.tool import ToolCreate, ToolRead, ToolUpdate

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("", response_model=list[ToolRead])
async def list_tools(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Tool).order_by(Tool.created_at))
    return result.scalars().all()


@router.post("", response_model=ToolRead, status_code=status.HTTP_201_CREATED)
async def create_tool(payload: ToolCreate, session: AsyncSession = Depends(get_session)):
    tool = Tool(**payload.model_dump())
    session.add(tool)
    await session.commit()
    await session.refresh(tool)
    return tool


@router.get("/{tool_id}", response_model=ToolRead)
async def get_tool(tool_id: str, session: AsyncSession = Depends(get_session)):
    tool = await session.get(Tool, tool_id)
    if tool is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tool not found")
    return tool


@router.patch("/{tool_id}", response_model=ToolRead)
async def update_tool(
    tool_id: str, payload: ToolUpdate, session: AsyncSession = Depends(get_session)
):
    tool = await session.get(Tool, tool_id)
    if tool is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tool not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(tool, key, value)
    session.add(tool)
    await session.commit()
    await session.refresh(tool)
    return tool


@router.delete("/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tool(tool_id: str, session: AsyncSession = Depends(get_session)):
    tool = await session.get(Tool, tool_id)
    if tool is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tool not found")
    await session.delete(tool)
    await session.commit()
