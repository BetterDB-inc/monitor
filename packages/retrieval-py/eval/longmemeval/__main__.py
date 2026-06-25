from __future__ import annotations

import asyncio
import sys

from .run import main

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as err:  # noqa: BLE001 - top-level CLI guard
        print(err, file=sys.stderr)
        sys.exit(1)
