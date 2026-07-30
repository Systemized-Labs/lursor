"""Coverage for Hermes integration detection.

Every case points ``HERMES_HOME`` at a tmp_path, so the suite never reads (let
alone reports on) the developer's real ``~/.hermes``.
"""

from __future__ import annotations

import pytest
import yaml

from app.api import integrations


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """A stand-in Hermes home, empty to start."""
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _write_plugin(home, version="0.2.0", name="lursor"):
    plugin = home / "plugins" / name
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(
        yaml.safe_dump({"name": name, "version": version}), encoding="utf-8"
    )
    (plugin / "__init__.py").write_text("", encoding="utf-8")
    return plugin


def _write_config(home, enabled):
    (home / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": list(enabled)}}), encoding="utf-8"
    )


async def test_reports_absence_without_guessing(client, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nope"))
    body = (await client.get("/integrations/hermes")).json()
    assert body["hermes_present"] is False
    assert body["plugin_installed"] is False
    assert "No Hermes install" in body["detail"]
    # The install command is offered regardless, so the UI has something to show.
    assert body["install_command"].startswith("hermes plugins install ")


async def test_installed_but_not_enabled_is_called_out(client, fake_home):
    _write_plugin(fake_home)
    _write_config(fake_home, [])
    body = (await client.get("/integrations/hermes")).json()
    assert body["plugin_installed"] is True
    # Hermes is opt-in: present-but-disabled must not read as working.
    assert body["plugin_enabled"] is False
    assert "not enabled" in body["detail"]
    assert body["enable_command"] == "hermes plugins enable lursor"


async def test_enabled_reads_as_connected(client, fake_home):
    _write_plugin(fake_home)
    _write_config(fake_home, ["lursor"])
    body = (await client.get("/integrations/hermes")).json()
    assert body["plugin_enabled"] is True
    assert body["installed_version"] == "0.2.0"
    assert body["detail"].startswith("Connected")


async def test_a_symlinked_checkout_is_flagged_as_such(client, fake_home, tmp_path):
    source = tmp_path / "checkout"
    source.mkdir()
    (source / "plugin.yaml").write_text(
        yaml.safe_dump({"name": "lursor", "version": "9.9.9"}), encoding="utf-8"
    )
    plugins = fake_home / "plugins"
    plugins.mkdir()
    (plugins / "lursor").symlink_to(source, target_is_directory=True)
    _write_config(fake_home, ["lursor"])

    body = (await client.get("/integrations/hermes")).json()
    assert body["plugin_installed"] is True
    assert body["plugin_linked"] is True
    assert "local checkout" in body["detail"]
    # A checkout tracks a branch, so version drift against the repo is expected
    # rather than something to nag about.
    assert body["update_available"] is False


async def test_version_drift_offers_an_upgrade(client, fake_home, monkeypatch):
    _write_plugin(fake_home, version="0.1.0")
    _write_config(fake_home, ["lursor"])
    monkeypatch.setattr(integrations, "_repo_plugin_dir", lambda: None)
    # With no repo copy to compare against there is nothing to claim.
    assert (await client.get("/integrations/hermes")).json()["update_available"] is False

    newer = fake_home / "repo-copy"
    newer.mkdir()
    (newer / "plugin.yaml").write_text(
        yaml.safe_dump({"name": "lursor", "version": "0.2.0"}), encoding="utf-8"
    )
    monkeypatch.setattr(integrations, "_repo_plugin_dir", lambda: newer)
    body = (await client.get("/integrations/hermes")).json()
    assert body["update_available"] is True
    assert "0.1.0" in body["detail"] and "0.2.0" in body["detail"]


async def test_an_unparseable_hermes_config_does_not_fail_the_request(client, fake_home):
    _write_plugin(fake_home)
    (fake_home / "config.yaml").write_text("plugins: [this: is: not: valid", encoding="utf-8")
    response = await client.get("/integrations/hermes")
    # Their file, not ours — degrade to "not enabled" rather than 500.
    assert response.status_code == 200
    assert response.json()["plugin_enabled"] is False


async def test_a_manifest_without_a_version_is_not_an_error(client, fake_home):
    plugin = fake_home / "plugins" / "lursor"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text(yaml.safe_dump({"name": "lursor"}), encoding="utf-8")
    _write_config(fake_home, ["lursor"])
    body = (await client.get("/integrations/hermes")).json()
    assert body["installed_version"] == ""
    assert body["plugin_enabled"] is True


async def test_detection_never_writes_to_the_hermes_home(client, fake_home):
    """The whole point of this router: it reports, it does not install."""
    _write_plugin(fake_home)
    _write_config(fake_home, ["lursor"])
    before = sorted(p.relative_to(fake_home).as_posix() for p in fake_home.rglob("*"))
    await client.get("/integrations/hermes")
    after = sorted(p.relative_to(fake_home).as_posix() for p in fake_home.rglob("*"))
    assert before == after


def test_cli_lookup_falls_back_when_path_is_minimal(tmp_path, monkeypatch):
    """A desktop-launched backend has a minimal PATH; ``which`` alone under-reports."""
    monkeypatch.setattr(integrations.shutil, "which", lambda _name: None)
    monkeypatch.setattr(integrations.Path, "home", staticmethod(lambda: tmp_path))
    assert integrations._find_cli() == ""

    local_bin = tmp_path / ".local" / "bin"
    local_bin.mkdir(parents=True)
    cli = local_bin / "hermes"
    cli.write_text("#!/bin/sh\n", encoding="utf-8")
    cli.chmod(0o755)
    assert integrations._find_cli() == str(cli)
