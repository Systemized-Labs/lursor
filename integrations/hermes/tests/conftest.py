"""Make the plugin importable as the ``lursor`` package.

Hermes loads a plugin from its directory; a test run has to put that directory's
parent on the path itself.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
