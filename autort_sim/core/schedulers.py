"""Ordering helpers and scheduling policy definitions."""

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from .task import Task


@dataclass
class SchedulableJob:
    """Small protocol-like record used by EDF ordering and tests."""

    task_name: str
    deadline: int
    priority: int = 1
    release: int = 0
    remaining: int = 0


def _job_name(job: Any) -> str:
    if hasattr(job, "task_name"):
        return str(job.task_name)
    if hasattr(job, "task"):
        return str(job.task.name)
    return str(getattr(job, "name", ""))


def _entry_name(entry: Any) -> str:
    return _job_name(entry)


def _period(entry: Any) -> int:
    if hasattr(entry, "task"):
        task = getattr(entry, "task")
        if hasattr(task, "period"):
            return int(task.period)
    if hasattr(entry, "period"):
        return int(entry.period)
    return 0


def _relative_deadline(entry: Any) -> int:
    if hasattr(entry, "task"):
        task = getattr(entry, "task")
        if hasattr(task, "relative_deadline"):
            return int(task.relative_deadline)
    if hasattr(entry, "deadline"):
        return int(entry.deadline)
    if hasattr(entry, "relative_deadline"):
        return int(entry.relative_deadline)
    return 0


def _priority_value(entry: Any) -> int:
    if hasattr(entry, "task"):
        task = getattr(entry, "task")
        if hasattr(task, "priority"):
            return int(task.priority)
    if hasattr(entry, "priority"):
        return int(entry.priority)
    return 1


def _job_release(job: Any) -> int:
    if hasattr(job, "release"):
        return int(job.release)
    if hasattr(job, "task"):
        return int(getattr(job.task, "release_offset", 0))
    return 0


def _job_priority(job: Any) -> int:
    if hasattr(job, "task"):
        return int(job.task.priority)
    if hasattr(job, "priority"):
        return int(job.priority)
    return 1


def _job_execution(job: Any) -> int:
    if hasattr(job, "task"):
        return int(job.task.execution_time)
    if hasattr(job, "execution_time"):
        return int(job.execution_time)
    if hasattr(job, "remaining"):
        return int(job.remaining)
    return 1


def _job_remaining(job: Any) -> int:
    if hasattr(job, "remaining"):
        return int(job.remaining)
    if hasattr(job, "task"):
        return int(job.task.execution_time)
    return _job_execution(job)


def rr_order(tasks: Iterable[Task]) -> list[Task]:
    """Capture the Round-Robin ordering as a stable FIFO order."""
    return list(tasks)


def rm_order(tasks: Iterable[Task]) -> list[Task]:
    """Order tasks by Rate-Monotonic priority (shortest period first)."""
    return sorted(tasks, key=lambda task: (_period(task), _priority_value(task), _entry_name(task).casefold()))


def edf_order(jobs: Iterable[SchedulableJob]) -> list[SchedulableJob]:
    """Order released jobs by Earliest Deadline First."""
    return sorted(
        jobs,
        key=lambda job: (_relative_deadline(job), _priority_value(job), _entry_name(job).casefold()),
    )


def fcfs_order(jobs: Iterable[Any]) -> list[Any]:
    """Order by arrival/release time, non-preemptive FCFS."""
    return sorted(jobs, key=lambda job: (_job_release(job), _job_name(job).casefold()))


def sjf_order(jobs: Iterable[Any]) -> list[Any]:
    """Order by shortest execution time, non-preemptive SJF."""
    return sorted(jobs, key=lambda job: (_job_execution(job), _job_release(job), _job_name(job).casefold()))


def srtf_order(jobs: Iterable[Any]) -> list[Any]:
    """Order by shortest remaining time, preemptive SRTF."""
    return sorted(jobs, key=lambda job: (_job_remaining(job), _job_release(job), _job_name(job).casefold()))


def priority_np_order(jobs: Iterable[Any]) -> list[Any]:
    """Order by lower numeric priority value first (non-preemptive)."""
    return sorted(jobs, key=lambda job: (_job_priority(job), _job_release(job), _job_name(job).casefold()))


def priority_p_order(jobs: Iterable[Any]) -> list[Any]:
    """Order by lower numeric priority value first (preemptive)."""
    return priority_np_order(jobs)


def priority_aging_order(jobs: Iterable[Any], aging_interval: int = 5) -> list[Any]:
    """Order by effective priority after aging: waiting jobs gradually become more urgent."""
    aging_interval = max(1, int(aging_interval))

    def effective_priority(job: Any) -> int:
        base = _job_priority(job)
        waited = getattr(job, "waiting_time", 0)
        return int(base + (waited // aging_interval))

    return sorted(
        jobs,
        key=lambda job: (effective_priority(job), _job_release(job), _job_name(job).casefold()),
    )


def mlq_order(jobs: Iterable[Any]) -> list[Any]:
    """Two-queue strict-priority scheduler: Safety-Critical outranks Non-Critical."""

    def queue_rank(job: Any) -> int:
        criticality = getattr(getattr(job, "task", job), "criticality", "Safety-Critical")
        return 0 if str(criticality) == "Safety-Critical" else 1

    return sorted(jobs, key=lambda job: (queue_rank(job), _job_release(job), _job_name(job).casefold()))


def mlfq_order(jobs: Iterable[Any], quanta: Sequence[int] = (2, 4, 8)) -> list[Any]:
    """Order MLFQ jobs by level, then their FIFO position within that level."""
    tuple(int(value) for value in quanta)

    def queue_level(job: Any) -> int:
        level = getattr(job, "mlfq_level", 0)
        return int(level)

    def queue_position(job: Any) -> tuple:
        if hasattr(job, "mlfq_queue_order"):
            return (0, int(job.mlfq_queue_order))
        return (1, _job_release(job), _job_name(job).casefold())

    return sorted(
        jobs,
        key=lambda job: (queue_level(job), *queue_position(job)),
    )


def hyperperiod(tasks: Sequence[Task], cap: int = 1000) -> int:
    """Return the task-set hyperperiod, capped for practical simulation."""
    if not tasks:
        return min(100, cap)
    result = 1
    for task in tasks:
        period = task.period
        result = result * period // _gcd(result, period)
        if result >= cap:
            return cap
    return min(result, cap)


def _gcd(first: int, second: int) -> int:
    while second:
        first, second = second, first % second
    return first
