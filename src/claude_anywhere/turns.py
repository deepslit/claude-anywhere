"""Per-session, persistent-across-HTTP-disconnects turn runner.

The previous design tied claude's lifetime to the SSE request that started it.
That meant any HTTP disconnect (mobile Safari backgrounding, network blip,
tunnel reset) killed the running turn. This module fixes that:

* ``TurnRunner`` owns the claude subprocess and an append-only event log.
* ``TurnManager`` keeps one active runner per session and tracks recently
  finished ones so a returning client can replay the tail.
* SSE responses subscribe to a runner; subscriber detach (client disconnect)
  does not affect the runner. Cancel goes through an explicit endpoint that
  terminates the subprocess.

The actual claude-NDJSON → web-event translation still lives in
``claude_proc`` — this module is the orchestration layer.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable


# Keep finished turns around for this long so a client returning from
# background can still replay the tail. After this window the runner can be
# garbage-collected by a subsequent ``start_turn``.
_FINISHED_RETENTION_SECONDS = 600.0


@dataclass
class EventEnvelope:
    id: int
    event: dict


class TurnRunner:
    """Drives one turn for one session. Subscribers come and go freely."""

    def __init__(self, *, session_id: str, turn_id: str) -> None:
        self.session_id = session_id
        self.turn_id = turn_id
        self.events: list[EventEnvelope] = []
        self._next_id = 1
        # Each live subscriber holds a queue we push new events onto. We use
        # a lock around the (events, subscribers) pair so a subscriber can
        # atomically snapshot the backlog and join the broadcast list
        # without missing or duplicating an event.
        self._subscribers: set[asyncio.Queue[EventEnvelope | None]] = set()
        self._lock = asyncio.Lock()
        self.done = False
        self.cancelled = False
        self.finished_at: float | None = None
        self.proc: asyncio.subprocess.Process | None = None

    # ── producer side ────────────────────────────────────────────────────

    def append(self, event: dict) -> int:
        """Append a translated event to the log and broadcast to subscribers.

        Synchronous on purpose — the producer (claude_proc) loops tightly and
        we want it to stay non-async around this call. We grab no lock for
        the append/broadcast because Python's GIL serialises list/set ops
        and queues are thread-safe; the lock in subscribe() is only there to
        coordinate the backlog snapshot vs. live-tail handoff.
        """
        if self.done:
            return -1
        eid = self._next_id
        self._next_id += 1
        env = EventEnvelope(id=eid, event=event)
        self.events.append(env)
        for q in list(self._subscribers):
            try:
                q.put_nowait(env)
            except asyncio.QueueFull:
                pass
        return eid

    def mark_done(self) -> None:
        if self.done:
            return
        self.done = True
        self.finished_at = time.monotonic()
        for q in list(self._subscribers):
            q.put_nowait(None)  # sentinel

    async def cancel(self) -> None:
        if self.done:
            return
        self.cancelled = True
        if self.proc is not None and self.proc.returncode is None:
            try:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    self.proc.kill()
                    await self.proc.wait()
            except ProcessLookupError:
                pass
        # The producer task will append a final "cancelled" event and call
        # mark_done() once it sees the proc exit. We don't double-finalise
        # here — that ordering keeps the event log consistent.

    # ── consumer side ────────────────────────────────────────────────────

    async def subscribe(
        self, *, since: int = 0
    ):
        """Yield ``EventEnvelope`` instances with id > ``since``.

        Yields immediately for any backlog past ``since`` and then continues
        live until the turn is done. Multiple concurrent subscribers each get
        a private queue.
        """
        q: asyncio.Queue[EventEnvelope | None] = asyncio.Queue()
        async with self._lock:
            backlog = [env for env in self.events if env.id > since]
            already_done = self.done
            self._subscribers.add(q)
        last_yielded = since
        try:
            for env in backlog:
                yield env
                last_yielded = env.id
            if already_done:
                return
            while True:
                item = await q.get()
                if item is None:  # done sentinel
                    return
                if item.id <= last_yielded:
                    # subscriber registered just before append() pushed an
                    # event already in our backlog snapshot — skip
                    continue
                yield item
                last_yielded = item.id
        finally:
            async with self._lock:
                self._subscribers.discard(q)

    @property
    def last_event_id(self) -> int:
        return self.events[-1].id if self.events else 0


class TurnManager:
    """One per app; keeps the active turn (if any) per session."""

    def __init__(self) -> None:
        self._by_session: dict[str, TurnRunner] = {}
        self._lock = asyncio.Lock()

    async def start(
        self,
        *,
        session_id: str,
        driver: Callable[[TurnRunner], Awaitable[None]],
    ) -> TurnRunner:
        """Create a TurnRunner and kick off ``driver`` as a background task.

        Refuses to start a second turn if one is already in flight; caller
        decides whether to surface that as a 409 or to silently subscribe to
        the existing runner.
        """
        async with self._lock:
            existing = self._by_session.get(session_id)
            if existing is not None and not existing.done:
                raise RuntimeError("a turn is already running for this session")
            # Garbage-collect a long-finished previous runner.
            if existing is not None and existing.finished_at is not None:
                if (
                    time.monotonic() - existing.finished_at
                    > _FINISHED_RETENTION_SECONDS
                ):
                    self._by_session.pop(session_id, None)

            runner = TurnRunner(session_id=session_id, turn_id=str(uuid.uuid4()))
            self._by_session[session_id] = runner

        async def _wrap() -> None:
            try:
                await driver(runner)
            finally:
                runner.mark_done()

        asyncio.create_task(_wrap())
        return runner

    def get(self, session_id: str) -> TurnRunner | None:
        return self._by_session.get(session_id)

    async def cancel(self, session_id: str) -> bool:
        runner = self._by_session.get(session_id)
        if runner is None or runner.done:
            return False
        await runner.cancel()
        return True
