"""Image and video generation sources.

Two of them: a **laios** box (self-hosted, billed in electricity, reached through
its inference gateway — see ``api/laios.py``) and **OpenRouter** (hosted, billed
per image or per clip). Which one runs is an app-wide setting, not a per-agent or
per-run choice; see ``AppConfig.image_source`` / ``video_source`` and
``api/settings.py``.

:mod:`app.media.refs` owns the string grammar that names a source and a model
across both. :mod:`app.media.openrouter` is the only module that talks to
openrouter.ai's media APIs.

Not to be confused with :mod:`app.media_store`, which is the content-addressed
blob store the finished bytes land in — either source writes to the same one.
"""
