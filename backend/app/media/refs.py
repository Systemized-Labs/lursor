"""How a media source and a media model are named as strings.

Every media route and every runtime used to be keyed on a laios ``connection_id``,
which stops working the moment a generation can happen somewhere that is not a
box. So the connection id generalises into a **source ref**, and the served name
generalises into a **model ref**:

* **source ref** — ``openrouter``, ``laios:{connection_id}``
  (e.g. ``laios:9f3c1a...``), or ``custom:{provider_id}``
* **model ref** — ``openrouter:{slug}`` (e.g.
  ``openrouter:google/gemini-2.5-flash-image``),
  ``laios:{connection_id}:{served_name}`` (e.g. ``laios:9f3c1a...:z-image-turbo``),
  or ``custom:{provider_id}:{model}`` (e.g. ``custom:4b21ef...:flux-schnell``)

The shape deliberately matches the chat side's ``openrouter:{id}`` /
``custom:{provider_id}:{model}`` (``api/models.py``, ``agents/builder.resolve_model``)
so there is one convention to learn rather than two — and ``custom`` names the
same :class:`~app.db.models.CustomProvider` rows on both sides. It is still *not*
the same namespace, though: a chat ref names a text model and a media ref names an
image or video model, and neither resolver will accept the other's strings.

A bare ``laios`` with no connection id is also accepted as a source and means "any
connected box", which is how the resolver behaved before this setting existed and
is what a stored ``AppConfig.image_source`` of ``"laios"`` means. A bare ``custom``
means the same thing one level over: any custom provider serving something
suitable.

**``connection_id`` is the endpoint id, whichever kind of endpoint it is** — a
laios connection for ``laios`` and a custom provider for ``custom``. Two id spaces
in one field would be a trap if either ref could omit its provider, but neither
can: the provider is always the first segment, so the id is never read without it.
The name is kept because it is also the column name on every generation row.

Model slugs contain slashes (``google/gemini-2.5-flash-image``) and served names
contain hyphens and dots (``qwen-image-2512``), but neither contains a colon, so
splitting on the first one or two colons is unambiguous.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# The three providers. Kept as plain strings rather than an enum because they are
# persisted in ``AppConfig.image_source`` and on every generation row, and a
# string round-trips through SQLite and JSON without ceremony.
LAIOS = "laios"
OPENROUTER = "openrouter"
CUSTOM = "custom"
PROVIDERS: tuple[str, ...] = (LAIOS, OPENROUTER, CUSTOM)

# The providers whose ref carries an endpoint id, i.e. everything but OpenRouter
# (of which there is exactly one, reached with one key).
ENDPOINT_PROVIDERS: tuple[str, ...] = (LAIOS, CUSTOM)

Provider = Literal["laios", "openrouter", "custom"]


class RefError(ValueError):
    """A ref that does not parse. Carries a message fit to show a user."""


def _expected() -> str:
    """The provider list as it reads in an error message."""
    return ", ".join(repr(p) for p in PROVIDERS)


@dataclass(frozen=True)
class SourceRef:
    """Which provider, and — for laios and custom — which endpoint.

    ``connection_id`` is empty for OpenRouter, and may also be empty for the other
    two, meaning "whichever configured endpoint is serving something suitable".
    """

    provider: str
    connection_id: str = ""

    def __str__(self) -> str:
        return format_source(self.provider, self.connection_id)

    @property
    def is_openrouter(self) -> bool:
        return self.provider == OPENROUTER

    @property
    def is_custom(self) -> bool:
        return self.provider == CUSTOM


@dataclass(frozen=True)
class ModelRef:
    """A specific model on a specific source.

    ``model`` is an OpenRouter slug, a laios *served* name (never a recipe id,
    since the served name is what the gateway routes on), or the model id a custom
    provider's own endpoint answers to.
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

    @property
    def is_custom(self) -> bool:
        return self.provider == CUSTOM


def format_source(provider: str, connection_id: str = "") -> str:
    """``"openrouter"``, or ``"{provider}"`` / ``"{provider}:{endpoint}"``."""
    if provider == OPENROUTER:
        return OPENROUTER
    head = provider if provider in ENDPOINT_PROVIDERS else LAIOS
    return f"{head}:{connection_id}" if connection_id else head


def format_model_ref(provider: str, model: str, connection_id: str = "") -> str:
    """The canonical ref for one model on one source."""
    if provider == OPENROUTER:
        return f"{OPENROUTER}:{model}"
    head = provider if provider in ENDPOINT_PROVIDERS else LAIOS
    return f"{head}:{connection_id}:{model}"


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
    if value in ENDPOINT_PROVIDERS:
        return SourceRef(value)
    head, _, rest = value.partition(":")
    if head in ENDPOINT_PROVIDERS:
        return SourceRef(head, rest.strip())
    if head == OPENROUTER:
        # ``openrouter:something`` is a model ref, not a source ref. Rejecting it
        # here rather than silently dropping the tail is what stops a mis-passed
        # model ref from quietly widening to "all of OpenRouter".
        raise RefError(
            f"{value!r} names a model, not a source — use 'openrouter' on its own"
        )
    raise RefError(f"{value!r} is not a media source (expected {_expected()})")


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
            f"{value!r} is not a media model ref (expected 'openrouter:<slug>', "
            f"'laios:<connection>:<model>' or 'custom:<provider>:<model>')"
        )
    if head == OPENROUTER:
        return ModelRef(OPENROUTER, rest.strip())
    if head in ENDPOINT_PROVIDERS:
        endpoint_id, sep, model = rest.partition(":")
        if not sep or not model.strip():
            raise RefError(
                f"{value!r} is missing its model name (expected "
                f"'{head}:<{'connection' if head == LAIOS else 'provider'}>:<model>')"
            )
        return ModelRef(head, model.strip(), endpoint_id.strip())
    raise RefError(f"{value!r} does not name a media source ({_expected()})")


def belongs_to(ref: ModelRef, source: SourceRef) -> bool:
    """Whether a model ref names a model on ``source``.

    A laios (or custom) source with no endpoint id matches any of them, so a pin
    made while two boxes were connected keeps working after one is removed — the
    resolver still has to find the model, and says so if it cannot.
    """
    if ref.provider != source.provider:
        return False
    if ref.provider == OPENROUTER:
        return True
    return not source.connection_id or ref.connection_id == source.connection_id
