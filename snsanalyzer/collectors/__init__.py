from .facebook import FacebookCollector
from .instagram import InstagramCollector
from .threads import ThreadsCollector
from .x import XCollector

COLLECTORS = {
    "instagram": InstagramCollector,
    "facebook": FacebookCollector,
    "threads": ThreadsCollector,
    "x": XCollector,
}

__all__ = ["COLLECTORS"]
