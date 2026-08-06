"""How a media source and a media model are named as strings.

Every media route and every runtime used to be keyed on a laios ``connection_id``,
which stops working the moment a generation can happen somewhere that is not a
box. So the connection id generalises into a **source ref**, and the served name
generalises into a **model ref**:

* **source ref** — ``openrouter``, or ``laios:{connection_id}``
  (e.g. ``laios:9f3c1a...``)
* **model ref** — ``openrouter:{slug}`` (e.g.
  ``openrouter:google/gemini-2.5-flash-image``), or
  ``laios:{connection_id}:{served_name}`` (e.g. ``laios:9f3c1a...:z-image-turbo``)

The shape deliberately matches the chat side's ``openrouter:{id}`` /
``custom:{provider_id}:{model}`` (``api/models.py``, ``agents/builder.resolve_model``)
so there is one convention to learn rather than two. It is *not* the same
namespace, though — a chat ref names a text model and a media ref names an image
or video model, and neither resolver will accept the other's strings.

A bare ``laios`` with no connection id is also accepted as a source and means "any
connected box", which is how the resolver behaved before this setting existed and
is what a stored ``AppConfig.image_source`` of ``"laios"`` means.

Model slugs contain slashes (``google/gemini-2.5-flash-image``) and served names
contain hyphens and dots (``qwen-image-2512``), but neither contains a colon, so
splitting on the first one or two colons is unambiguous.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# The two providers. Kept as plain strings rather than an enum because they are
# persisted in ``AppConfig.image_source`` and on every generation row, and a
# string round-trips through SQLite and JSON without ceremony.
LAIOS = "laios"
OPENROUTER = "openrouter"
PROVIDERS: tuple[str, ...] = (LAIOS, OPENROUTER)

Provider = Literal["laios", "openrouter"]


class RefError(ValueError):
    """A ref that does not parse. Carries a message fit to show a user."""


@dataclass(frozen=True)
class SourceRef:
    """Which provider, and — for laios — which box.

    ``connection_id`` is empty for OpenRouter, and may also be empty for laios,
    meaning "whichever connected box is serving something suitable".
    """

    provider: str
    connection_id: str = ""

    def __str__(self) -> str:
        return format_source(self.provider, self.connection_id)

    @property
    def is_openrouter(self) -> bool:
        return self.provider == OPENROUTER


@dataclass(frozen=True)
class ModelRef:
    """A specific model on a specific source.

    ``model`` is an OpenRouter slug or a laios *served* name — never a recipe id,
    since the served name is what the gateway routes on.
    """

    provider: str
    model: str
    connection_id: str = ""

    def __str__(self) -> str:
        return format_model_ref(self.provider, self.model, self.connection_id)

    @property
    def source(self) -> SourceRef:
        return SourceRef(self.provider, self.connection_id)

    @property
    def is_openrouter(self) -> bool:
        return self.provider == OPENROUTER


def format_source(provider: str, connection_id: str = "") -> str:
    """``"openrouter"`` or ``"laios"`` / ``"laios:{cid}"``."""
    if provider == OPENROUTER:
        return OPENROUTER
    return f"{LAIOS}:{connection_id}" if connection_id else LAIOS


def format_model_ref(provider: str, model: str, connection_id: str = "") -> str:
    """The canonical ref for one model on one source."""
    if provider == OPENROUTER:
        return f"{OPENROUTER}:{model}"
    return f"{LAIOS}:{connection_id}:{model}"


def parse_source(raw: str | None) -> SourceRef:
    """Parse a source ref, defaulting to "any laios box".

    ``None`` and ``""`` both mean laios, which is what a NULL
    ``AppConfig.image_source`` means and therefore what every install did before
    the setting existed.
    """
    value = (raw or "").strip()
    if not value or value == LAIOS:
        return SourceRef(LAIOS)
    if value == OPENROUTER:
        return SourceRef(OPENROUTER)
    head, _, rest = value.partition(":")
    if head == LAIOS:
        return SourceRef(LAIOS, rest.strip())
    if head == OPENROUTER:
        # ``openrouter:something`` is a model ref, not a source ref. Rejecting it
        # here rather than silently dropping the tail is what stops a mis-passed
        # model ref from quietly widening to "all of OpenRouter".
        raise RefError(
            f"{value!r} names a model, not a source — use 'openrouter' on its own"
        )
    raise RefError(f"{value!r} is not a media source (expected 'laios' or 'openrouter')")


def parse_model_ref(raw: str | None) -> ModelRef | None:
    """Parse a model ref, or ``None`` for a blank one (= "auto").

    A blank pin is a real state, not an error: it means "the cheapest model the
    source is offering", which is the default for both modalities.
    """
    value = (raw or "").strip()
    if not value:
        return None
    head, sep, rest = value.partition(":")
    if not sep or not rest.strip():
        raise RefError(
            f"{value!r} is not a media model ref (expected 'openrouter:<slug>' or "
            f"'laios:<connection>:<model>')"
        )
    if head == OPENROUTER:
        return ModelRef(OPENROUTER, rest.strip())
    if head == LAIOS:
        connection_id, sep, model = rest.partition(":")
        if not sep or not model.strip():
            raise RefError(
                f"{value!r} is missing its model name (expected "
                f"'laios:<connection>:<model>')"
            )
        return ModelRef(LAIOS, model.strip(), connection_id.strip())
    raise RefError(f"{value!r} does not name a media source ('laios' or 'openrouter')")


def belongs_to(ref: ModelRef, source: SourceRef) -> bool:
    """Whether a model ref names a model on ``source``.

    A laios source with no connection id matches any box, so a pin made while two
    boxes were connected keeps working after one is removed — the resolver still
    has to find the model, and says so if it cannot.
    """
    if ref.provider != source.provider:
        return False
    if ref.provider == OPENROUTER:
        return True
    return not source.connection_id or ref.connection_id == source.connection_id
