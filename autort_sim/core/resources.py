"""Mutex ownership, blocking, handoff, and priority-inheritance helpers."""

from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class MutexManager:
    """Track mutex owners and FIFO wait queues for one simulation run."""

    owners: dict[str, str] = field(default_factory=dict)
    waiters: dict[str, list[str]] = field(default_factory=dict)

    def try_acquire(self, resource: str, job_id: str) -> tuple[bool, str]:
        """Acquire an unowned mutex or enqueue the job as a waiter."""
        owner = self.owners.get(resource)
        if owner is None:
            self.owners[resource] = job_id
            return True, f"{job_id} locked {resource}."
        if owner == job_id:
            return True, f"{job_id} already owns {resource}."
        queue = self.waiters.setdefault(resource, [])
        if job_id not in queue:
            queue.append(job_id)
        return False, f"{job_id} blocked on {resource}, held by {owner}."

    def release(
        self,
        resource: str,
        job_id: str,
        rank_for: Callable[[str], tuple],
    ) -> tuple[Optional[str], str]:
        """Unlock a mutex and hand it to the most urgent queued job, if any."""
        if self.owners.get(resource) != job_id:
            return None, f"{job_id} attempted to unlock unowned {resource}."
        queue = self.waiters.setdefault(resource, [])
        self.owners.pop(resource, None)
        if not queue:
            return None, f"{job_id} unlocked {resource}."
        next_job = min(queue, key=rank_for)
        queue.remove(next_job)
        self.owners[resource] = next_job
        return next_job, f"{job_id} unlocked {resource}; ownership handed to {next_job}."

    def owner_of(self, resource: str) -> Optional[str]:
        """Return the current owner of a resource, if locked."""
        return self.owners.get(resource)

    def waiters_for(self, resource: str) -> tuple[str, ...]:
        """Return an immutable snapshot of jobs waiting on a resource."""
        return tuple(self.waiters.get(resource, ()))

    def inherited_ranks(self, rank_for: Callable[[str], tuple]) -> dict[str, tuple]:
        """Return each owner boosted to its most urgent waiter's scheduling rank."""
        boosts: dict[str, tuple] = {}
        for resource, owner in self.owners.items():
            queue = self.waiters.get(resource, [])
            if queue:
                inherited = min((rank_for(waiter) for waiter in queue))
                boosts[owner] = min(rank_for(owner), inherited)
        return boosts
