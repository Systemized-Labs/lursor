"""Workspace content search (``GET /workspaces/{id}/files/grep``).

The endpoint has two implementations — ripgrep when the machine has it, a plain
Python walk when it doesn't — and a packaged build cannot assume ripgrep, so both
have to be correct. Every behavioural test here is parametrized over the two via
the ``engine`` fixture, which forces the walk by making ``shutil.which`` come up
empty. When ripgrep really is absent the ``rg`` half is skipped rather than
silently testing the walk twice.
"""

from __future__ import annotations

import shutil

import pytest
from httpx import AsyncClient

from app.api import files as files_api

RG_AVAILABLE = shutil.which("rg") is not None


@pytest.fixture(params=["walk", "rg"])
def engine(request, monkeypatch):
    """Force one of the two search implementations for the request under test."""
    if request.param == "walk":
        monkeypatch.setattr(files_api.shutil, "which", lambda _name: None)
    elif not RG_AVAILABLE:
        pytest.skip("ripgrep is not installed on this machine")
    return request.param


async def _workspace(client: AsyncClient, name: str, tree: dict[str, str]) -> str:
    """Create a workspace and write ``{relative path: text}`` into it."""
    wid = (await client.post("/workspaces", json={"name": name})).json()["id"]
    for path, content in tree.items():
        r = await client.put(
            f"/workspaces/{wid}/files/write", json={"path": path, "content": content}
        )
        assert r.status_code == 200, r.text
    return wid


async def _grep(client: AsyncClient, wid: str, **params) -> dict:
    r = await client.get(f"/workspaces/{wid}/files/grep", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def test_grep_finds_a_literal_needle(client: AsyncClient, engine: str):
    """A plain query reports the file, the 1-based line and column, and the line."""
    wid = await _workspace(
        client,
        f"grep-literal-{engine}",
        {
            "src/app.ts": "import x from 'y'\nconst needle = 1\n",
            "docs/readme.md": "nothing here\n",
        },
    )

    result = await _grep(client, wid, q="needle")

    assert result["matches"] == [
        {
            "path": "src/app.ts",
            "line": 2,
            "column": 7,
            "text": "const needle = 1",
            "match_length": 6,
            "text_offset": 0,
        }
    ]
    assert result["truncated"] is False
    assert result["files_scanned"] >= 1


async def test_grep_is_case_insensitive_until_asked(client: AsyncClient, engine: str):
    """``case`` flips the default insensitive match to an exact one."""
    wid = await _workspace(
        client, f"grep-case-{engine}", {"a.txt": "Needle\nneedle\n"}
    )

    loose = await _grep(client, wid, q="needle")
    assert [m["line"] for m in loose["matches"]] == [1, 2]

    strict = await _grep(client, wid, q="needle", case=True)
    assert [m["line"] for m in strict["matches"]] == [2]


async def test_grep_treats_the_query_as_literal_by_default(
    client: AsyncClient, engine: str
):
    """Regex metacharacters are text until ``regex`` says otherwise."""
    wid = await _workspace(
        client, f"grep-literal-dots-{engine}", {"a.txt": "a.c\nabc\n"}
    )

    literal = await _grep(client, wid, q="a.c")
    assert [m["line"] for m in literal["matches"]] == [1]

    as_regex = await _grep(client, wid, q="a.c", regex=True)
    assert [m["line"] for m in as_regex["matches"]] == [1, 2]


async def test_grep_regex_and_whole_word(client: AsyncClient, engine: str):
    """A real pattern matches, and ``whole_word`` requires word boundaries."""
    wid = await _workspace(
        client,
        f"grep-regex-{engine}",
        {"a.py": "value = 42\nvalues = 7\nother = 1\n"},
    )

    pattern = await _grep(client, wid, q=r"value\w*\s*=", regex=True)
    assert [m["line"] for m in pattern["matches"]] == [1, 2]

    exact = await _grep(client, wid, q="value", whole_word=True)
    assert [m["line"] for m in exact["matches"]] == [1]


async def test_grep_invalid_regex_is_422_not_500(client: AsyncClient, engine: str):
    """A mistyped pattern is the user's error, and says so."""
    wid = await _workspace(client, f"grep-bad-regex-{engine}", {"a.txt": "x\n"})

    r = await client.get(
        f"/workspaces/{wid}/files/grep", params={"q": "a(", "regex": True}
    )
    assert r.status_code == 422
    assert "regular expression" in r.json()["detail"].lower()


async def test_grep_include_filters_by_glob(client: AsyncClient, engine: str):
    """``include`` narrows by path glob, and a bare pattern means the filename."""
    wid = await _workspace(
        client,
        f"grep-include-{engine}",
        {
            "src/a.ts": "needle\n",
            "src/deep/b.ts": "needle\n",
            "src/c.js": "needle\n",
            "docs/d.ts": "needle\n",
        },
    )

    everything = await _grep(client, wid, q="needle")
    assert len(everything["matches"]) == 4

    # No `/`, so this is about the filename at any depth.
    typescript = await _grep(client, wid, q="needle", include="*.ts")
    assert {m["path"] for m in typescript["matches"]} == {
        "src/a.ts",
        "src/deep/b.ts",
        "docs/d.ts",
    }

    # With a `/` it is a path glob, rooted at the workspace.
    under_src = await _grep(client, wid, q="needle", include="src/*")
    assert {m["path"] for m in under_src["matches"]} == {
        "src/a.ts",
        "src/deep/b.ts",
        "src/c.js",
    }

    # Comma-separated globs are a union.
    either = await _grep(client, wid, q="needle", include="*.js,docs/*")
    assert {m["path"] for m in either["matches"]} == {"src/c.js", "docs/d.ts"}


async def test_grep_prunes_ignored_directories(client: AsyncClient, engine: str):
    """Noise dirs are invisible to search, exactly as they are to the tree.

    Both implementations must agree here, which is the reason ripgrep is run with
    ``--no-ignore`` and an explicit exclude per ignored directory rather than
    letting a checkout's ``.gitignore`` decide.
    """
    wid = await _workspace(
        client,
        f"grep-ignored-{engine}",
        {
            "src/real.ts": "needle\n",
            "node_modules/pkg/index.js": "needle\n",
            "dist/bundle.js": "needle\n",
            ".git/COMMIT_EDITMSG": "needle\n",
            "__pycache__/x.pyc": "needle\n",
        },
    )

    result = await _grep(client, wid, q="needle")
    assert [m["path"] for m in result["matches"]] == ["src/real.ts"]


async def test_grep_skips_binary_files(client: AsyncClient, engine: str):
    """A NUL byte means the file isn't text, so it can't produce a match."""
    wid = await _workspace(client, f"grep-binary-{engine}", {"notes.txt": "needle\n"})
    r = await client.post(
        f"/workspaces/{wid}/files/upload",
        data={"path": ""},
        files=[("files", ("blob.bin", b"needle\x00needle", "application/octet-stream"))],
    )
    assert r.status_code == 201

    result = await _grep(client, wid, q="needle")
    assert [m["path"] for m in result["matches"]] == ["notes.txt"]


async def test_grep_truncates_at_the_limit(client: AsyncClient, engine: str):
    """Hitting ``limit`` caps the list and is reported, never implied away."""
    wid = await _workspace(
        client,
        f"grep-limit-{engine}",
        {f"f{i}.txt": "needle\n" for i in range(10)},
    )

    capped = await _grep(client, wid, q="needle", limit=4)
    assert len(capped["matches"]) == 4
    assert capped["truncated"] is True

    whole = await _grep(client, wid, q="needle", limit=50)
    assert len(whole["matches"]) == 10
    assert whole["truncated"] is False


async def test_grep_caps_matches_per_file(client: AsyncClient, engine: str):
    """One pathological file can't spend the whole budget."""
    cap = files_api._MAX_GREP_MATCHES_PER_FILE
    wid = await _workspace(
        client,
        f"grep-per-file-{engine}",
        {
            "huge.txt": "needle\n" * (cap + 25),
            "small.txt": "needle\n",
        },
    )

    result = await _grep(client, wid, q="needle", limit=200)
    from_huge = [m for m in result["matches"] if m["path"] == "huge.txt"]
    assert len(from_huge) == cap
    assert result["truncated"] is True
    # The other file still gets its turn — the cap is per file, not a global stop.
    assert any(m["path"] == "small.txt" for m in result["matches"])


async def test_grep_windows_a_very_long_line(client: AsyncClient, engine: str):
    """A minified line comes back as a window, with the offset needed to place it.

    ``column`` stays true to the file (it is what the editor jumps to), so the
    client locates the match inside ``text`` as ``column - 1 - text_offset``.
    """
    filler = "x" * 5_000
    wid = await _workspace(
        client, f"grep-long-line-{engine}", {"min.js": f"{filler}needle{filler}\n"}
    )

    result = await _grep(client, wid, q="needle")
    (match,) = result["matches"]

    assert match["column"] == len(filler) + 1
    assert match["text_offset"] > 0
    assert len(match["text"]) <= files_api._MAX_GREP_LINE_CHARS
    start = match["column"] - 1 - match["text_offset"]
    assert match["text"][start : start + match["match_length"]] == "needle"


async def test_grep_reports_column_in_characters_not_bytes(
    client: AsyncClient, engine: str
):
    """Multi-byte text ahead of a match doesn't push the column off.

    ripgrep reports byte offsets and Monaco counts characters, so the two
    implementations would disagree here if the conversion were missing.
    """
    wid = await _workspace(client, f"grep-unicode-{engine}", {"a.txt": "héllo→ needle\n"})

    result = await _grep(client, wid, q="needle")
    (match,) = result["matches"]

    assert match["column"] == len("héllo→ ") + 1
    assert match["text"] == "héllo→ needle"


async def test_grep_empty_query_returns_nothing(client: AsyncClient, engine: str):
    """A blank needle is not a request to list the workspace."""
    wid = await _workspace(client, f"grep-blank-{engine}", {"a.txt": "needle\n"})

    result = await _grep(client, wid, q="   ")
    assert result == {"matches": [], "truncated": False, "files_scanned": 0}


async def test_grep_rejects_a_missing_workspace(client: AsyncClient, engine: str):
    """No workspace, no search — and a 404 rather than an empty result."""
    r = await client.get("/workspaces/does-not-exist/files/grep", params={"q": "x"})
    assert r.status_code == 404


async def test_grep_stays_inside_the_workspace_root(
    client: AsyncClient, engine: str, tmp_path
):
    """A match outside the root is impossible: the search is rooted, not pathed.

    There is no client-supplied path to traverse with here — ``include`` is a glob
    applied to results, not a directory to search — so the guard being tested is
    that a `..` glob simply matches nothing rather than reaching out of the tree.
    """
    outside = tmp_path / "secret.txt"
    outside.write_text("needle\n", encoding="utf-8")
    wid = await _workspace(client, f"grep-confined-{engine}", {"inside.txt": "needle\n"})

    escape = await _grep(client, wid, q="needle", include="../*")
    assert escape["matches"] == []

    normal = await _grep(client, wid, q="needle")
    assert [m["path"] for m in normal["matches"]] == ["inside.txt"]
