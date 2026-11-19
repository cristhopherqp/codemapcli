"""Monitorización de cambios en solo lectura con watchdog (debounce 1.0 s)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from codemap.discovery import IGNORED_DIRS, GitIgnoreMatcher, is_supported_file

DEFAULT_DEBOUNCE_SECONDS = 1.0
READ_ONLY_EVENTS = frozenset({"opened", "closed", "closed_no_write"})
RELEVANT_CONFIG_NAMES = frozenset({"tsconfig.json", "jsconfig.json"})


class DebouncedRebuildHandler(FileSystemEventHandler):
    """Filtra eventos irrelevantes/.gitignore y agrupa guardados en 1.0 s."""

    def __init__(
        self,
        target: Path,
        is_single_file: bool,
        loop: asyncio.AbstractEventLoop,
        on_rebuild: Callable[[], Awaitable[None]],
        debounce_seconds: float = DEFAULT_DEBOUNCE_SECONDS,
    ) -> None:
        super().__init__()
        self.target = target.resolve()
        self.is_single_file = is_single_file
        self.loop = loop
        self.on_rebuild = on_rebuild
        self.debounce_seconds = debounce_seconds
        self.gitignore = None if is_single_file else GitIgnoreMatcher(self.target)
        self._timer_handle: asyncio.TimerHandle | None = None

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory or event.event_type in READ_ONLY_EVENTS:
            return
        candidates = [getattr(event, "src_path", None), getattr(event, "dest_path", None)]
        if any(self._is_relevant_path(raw) for raw in candidates if raw):
            self.loop.call_soon_threadsafe(self._schedule_debounce)

    def _is_relevant_path(self, raw_path: str) -> bool:
        try:
            path = Path(raw_path).resolve()
        except OSError:
            return False

        if self.is_single_file:
            return path == self.target

        try:
            rel_parts = path.relative_to(self.target).parts
        except ValueError:
            return False

        if any(part in IGNORED_DIRS for part in rel_parts[:-1]):
            return False

        if path.name == ".gitignore" and self.gitignore is not None:
            if len(rel_parts) == 1 or not self.gitignore.is_path_ignored(path.parent, is_dir=True):
                self.gitignore.reload_dir(path.parent)
                return True
            return False

        if path.name in RELEVANT_CONFIG_NAMES:
            return self.gitignore is None or not self.gitignore.is_path_ignored(path, is_dir=False)

        if not is_supported_file(path):
            return False

        if self.gitignore is None:
            return True
        return not self.gitignore.is_path_ignored(path, is_dir=False)

    def _schedule_debounce(self) -> None:
        if self._timer_handle is not None:
            self._timer_handle.cancel()
        self._timer_handle = self.loop.call_later(self.debounce_seconds, self._trigger_rebuild)

    def _trigger_rebuild(self) -> None:
        self._timer_handle = None
        self.loop.create_task(self.on_rebuild())


def start_watcher(
    target: Path,
    is_single_file: bool,
    loop: asyncio.AbstractEventLoop,
    on_rebuild: Callable[[], Awaitable[None]],
) -> Observer:
    """Inicia el observer de watchdog en el directorio o archivo objetivo."""
    handler = DebouncedRebuildHandler(
        target=target,
        is_single_file=is_single_file,
        loop=loop,
        on_rebuild=on_rebuild,
    )
    observer = Observer()
    watch_dir = target.parent if is_single_file else target
    observer.schedule(handler, str(watch_dir), recursive=not is_single_file)
    observer.start()
    return observer
