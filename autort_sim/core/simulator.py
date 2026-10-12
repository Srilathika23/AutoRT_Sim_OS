"""Discrete-time preemptive simulation engine for periodic real-time tasks."""

from collections import deque
from dataclasses import dataclass
from typing import Any, Optional, Sequence

from .metrics import calculate_metrics
from .resources import MutexManager
from .schedulers import (
    fcfs_order,
    mlfq_order,
    mlq_order,
    priority_aging_order,
    priority_np_order,
    priority_p_order,
    rm_order,
    rr_order,
    sjf_order,
    srtf_order,
    edf_order,
)
from .task import Task

ALGORITHM_GROUPS = {
    "Basic": {"FCFS", "SJF", "SRTF"},
    "Priority-based": {"PRIORITY_NP", "PRIORITY_P", "PRIORITY_AGING"},
    "Time-sliced": {"RR", "MLQ", "MLFQ"},
    "Real-time": {"RM", "EDF"},
}


def _normalize_name(name: str) -> str:
    mapping = {
        "Round Robin": "RR",
        "Rate-Monotonic": "RM",
        "Earliest Deadline First": "EDF",
        "FCFS": "FCFS",
        "SJF": "SJF",
        "SRTF": "SRTF",
        "PRIORITY_NP": "PRIORITY_NP",
        "PRIORITY_P": "PRIORITY_P",
        "PRIORITY_AGING": "PRIORITY_AGING",
        "MLQ": "MLQ",
        "MLFQ": "MLFQ",
    }
    return mapping.get(name, name)


ALGORITHM_REGISTRY: dict[str, dict[str, Any]] = {
    "RR": {"label": "Round Robin", "group": "Time-sliced", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, rr_order), "extra_params": {"quantum": 2}},
    "RM": {"label": "Rate-Monotonic", "group": "Real-time", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, rm_order), "extra_params": {}},
    "EDF": {"label": "Earliest Deadline First", "group": "Real-time", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, edf_order), "extra_params": {}},
    "FCFS": {"label": "FCFS", "group": "Basic", "preemptive": False, "function": lambda ready, **kwargs: _select_by_order(ready, fcfs_order), "extra_params": {}},
    "SJF": {"label": "SJF", "group": "Basic", "preemptive": False, "function": lambda ready, **kwargs: _select_by_order(ready, sjf_order), "extra_params": {}},
    "SRTF": {"label": "SRTF", "group": "Basic", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, srtf_order), "extra_params": {}},
    "PRIORITY_NP": {"label": "Priority non-preemptive", "group": "Priority-based", "preemptive": False, "function": lambda ready, **kwargs: _select_by_order(ready, priority_np_order), "extra_params": {}},
    "PRIORITY_P": {"label": "Priority preemptive", "group": "Priority-based", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, priority_p_order), "extra_params": {}},
    "PRIORITY_AGING": {"label": "Priority with Aging", "group": "Priority-based", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, priority_aging_order, aging_interval=kwargs.get("aging_interval", 5)), "extra_params": {"aging_interval": 5}},
    "MLQ": {"label": "Multilevel Queue", "group": "Time-sliced", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, mlq_order), "extra_params": {"quantum": 2}},
    "MLFQ": {"label": "MLFQ", "group": "Time-sliced", "preemptive": True, "function": lambda ready, **kwargs: _select_by_order(ready, mlfq_order, quanta=kwargs.get("mlfq_quanta", (2, 4, 8))), "extra_params": {"boost_interval": 20, "mlfq_quanta": [2, 4, 8]}},
}

ALGORITHMS = tuple(ALGORITHM_REGISTRY.keys())


@dataclass
class _Job:
    """Runtime state for one released instance of a periodic task."""

    job_id: str
    task: Task
    release: int
    deadline: int
    remaining: int
    lock_state: str = "new"
    lock_remaining: int = 0
    blocked: bool = False
    started_at: Optional[int] = None
    completed_at: Optional[int] = None
    missed: bool = False
    waiting_time: int = 0
    mlfq_level: int = 0
    mlfq_quantum_used: int = 0
    mlfq_queue_order: int = 0


def _select_by_order(ready: Sequence[_Job], order_fn: Any, **kwargs: Any) -> Optional[_Job]:
    if not ready:
        return None
    ordered = list(order_fn(list(ready), **kwargs))
    return ordered[0] if ordered else None


def _algorithm_label(name: str) -> str:
    return ALGORITHM_REGISTRY.get(_normalize_name(name), {}).get("label", name)


def _applies_priority_inheritance(algorithm_key: str) -> bool:
    return algorithm_key in {"RM", "PRIORITY_NP", "PRIORITY_P", "PRIORITY_AGING"}


def run_simulation(
    tasks: Sequence[Task],
    algorithm: str = "RM",
    duration: int = 100,
    time_quantum: int = 2,
    priority_inheritance: bool = False,
    params: Optional[dict[str, Any]] = None,
) -> dict:
    """Run a tick-based simulation and return its timeline, events, jobs, and metrics."""
    params = dict(params or {})
    algorithm_key = _normalize_name(algorithm)
    if algorithm_key not in ALGORITHM_REGISTRY:
        raise ValueError(f"Algorithm must be one of: {', '.join(ALGORITHMS)}.")
    if not 1 <= duration <= 1000:
        raise ValueError("Simulation length must be between 1 and 1000 ticks.")
    if time_quantum <= 0:
        raise ValueError("Time quantum must be positive.")
    task_list = list(tasks)
    if len({task.name.casefold() for task in task_list}) != len(task_list):
        raise ValueError("Task names must be unique.")

    jobs: list[_Job] = []
    jobs_by_id: dict[str, _Job] = {}
    events: list[dict] = []
    timeline: list[dict] = []
    mutexes = MutexManager()
    rr_queue: deque[str] = deque()
    mlfq_queue_sequence = 0
    context_switches = 0
    previous_running: Optional[str] = None
    rr_current: Optional[str] = None
    rr_elapsed = 0
    prior_boosts: set[str] = set()
    aging_interval = int(params.get("aging_interval", 5))
    mlfq_quanta = tuple(int(piece) for piece in params.get("mlfq_quanta", (2, 4, 8))) or (2, 4, 8)
    boost_interval = int(params.get("boost_interval", 20)) or 20
    if algorithm_key == "MLFQ" and (
        len(mlfq_quanta) != 3 or any(quantum <= 0 for quantum in mlfq_quanta) or boost_interval <= 0
    ):
        raise ValueError("MLFQ requires three positive quanta and a positive boost interval.")
    algorithm_group = ALGORITHM_REGISTRY[algorithm_key]["group"]
    algorithm_config = ALGORITHM_REGISTRY[algorithm_key]

    def add_event(time: int, kind: str, task_name: str, detail: str) -> None:
        events.append({"time": time, "kind": kind, "task": task_name, "detail": detail})

    def rank_for(job_id: str) -> tuple:
        job = jobs_by_id[job_id]
        if algorithm_key == "RM":
            return (job.task.period, job.task.priority, job.task.name.casefold(), job.release)
        if algorithm_key == "EDF":
            return (job.deadline, job.task.priority, job.task.name.casefold(), job.release)
        if algorithm_key == "PRIORITY_P" or algorithm_key == "PRIORITY_NP":
            return (job.task.priority, job.release, job.task.name.casefold())
        if algorithm_key == "PRIORITY_AGING":
            effective = job.task.priority + (job.waiting_time // aging_interval)
            return (effective, job.release, job.task.name.casefold())
        if algorithm_key == "FCFS":
            return (job.release, job.task.name.casefold())
        if algorithm_key == "SJF":
            return (job.task.execution_time, job.release, job.task.name.casefold())
        if algorithm_key == "SRTF":
            return (job.remaining, job.release, job.task.name.casefold())
        if algorithm_key == "MLQ":
            queue = 0 if job.task.criticality == "Safety-Critical" else 1
            return (queue, job.release, job.task.name.casefold())
        if algorithm_key == "MLFQ":
            return (job.mlfq_level, job.release, job.task.name.casefold())
        return (job.task.priority, job.task.name.casefold(), job.release)

    def remove_from_rr(job_id: str) -> None:
        try:
            rr_queue.remove(job_id)
        except ValueError:
            pass

    def enqueue_mlfq(job: _Job) -> None:
        nonlocal mlfq_queue_sequence
        job.mlfq_queue_order = mlfq_queue_sequence
        mlfq_queue_sequence += 1

    def mark_deadlines(time: int) -> None:
        for job in jobs:
            if not job.missed and job.completed_at is None and job.deadline <= time:
                job.missed = True
                add_event(time, "Deadline miss", job.task.name, f"Job deadline {job.deadline} passed unfinished.")

    def release_jobs(time: int) -> None:
        for task in task_list:
            if time >= task.release_offset and (time - task.release_offset) % task.period == 0:
                release_number = (time - task.release_offset) // task.period
                job_id = f"{task.name}#{release_number}"
                job = _Job(job_id, task, time, time + task.relative_deadline, task.execution_time)
                job.mlfq_level = 0
                job.mlfq_quantum_used = 0
                if algorithm_key == "MLFQ":
                    enqueue_mlfq(job)
                jobs.append(job)
                jobs_by_id[job_id] = job
                rr_queue.append(job_id)
                add_event(time, "Release", task.name, f"Job released; absolute deadline {job.deadline}.")

    def select_for_algorithm(ready: list[_Job], now: int) -> Optional[_Job]:
        if not ready:
            return None
        if priority_inheritance and _applies_priority_inheritance(algorithm_key):
            boosts = mutexes.inherited_ranks(rank_for)
            boosted = [job for job in ready if job.job_id in boosts]
            if boosted:
                return min(boosted, key=lambda job: boosts[job.job_id])
        config = ALGORITHM_REGISTRY[algorithm_key]
        selector = config["function"]
        # For the preemptive/non-preemptive algorithms, keep the current running job if allowed.
        if not config["preemptive"] and previous_running is not None:
            current = jobs_by_id.get(previous_running)
            if current is not None and current in ready and current.completed_at is None and not current.blocked:
                return current
        if algorithm_key == "RR":
            for job_id in rr_queue:
                for candidate in ready:
                    if candidate.job_id == job_id:
                        return candidate
        if algorithm_key == "MLQ":
            queue_safe = [job for job in ready if job.task.criticality == "Safety-Critical"]
            queue_normal = [job for job in ready if job.task.criticality != "Safety-Critical"]
            if queue_safe:
                return selector(queue_safe, aging_interval=aging_interval, now=now)
            return selector(queue_normal, aging_interval=aging_interval, now=now)
        if algorithm_key == "MLFQ":
            for candidate in ready:
                candidate.waiting_time = max(0, now - candidate.release)
            return selector(ready, quanta=mlfq_quanta, now=now)
        if algorithm_key == "PRIORITY_AGING":
            for candidate in ready:
                candidate.waiting_time = max(0, now - max(candidate.release, candidate.started_at or candidate.release))
            return selector(ready, aging_interval=aging_interval, now=now)
        return selector(ready, aging_interval=aging_interval, now=now)

    def acquire_if_needed(job: _Job, time: int) -> bool:
        if not job.task.shared_resource or job.task.resource_hold_time <= 0 or job.lock_state != "new":
            return True
        acquired, detail = mutexes.try_acquire(job.task.shared_resource, job.job_id)
        if acquired:
            job.lock_state = "held"
            job.lock_remaining = job.task.resource_hold_time
            add_event(time, "Mutex lock", job.task.name, detail)
            return True
        job.lock_state = "waiting"
        job.blocked = True
        remove_from_rr(job.job_id)
        add_event(time, "Mutex block", job.task.name, detail)
        owner_id = mutexes.owner_of(job.task.shared_resource)
        if owner_id and priority_inheritance and _applies_priority_inheritance(algorithm_key):
            add_event(time, "Priority inheritance", jobs_by_id[owner_id].task.name,
                      f"Temporarily inherits urgency from {job.task.name} waiting on {job.task.shared_resource}.")
        return False

    def release_mutex(job: _Job, time: int) -> None:
        resource = job.task.shared_resource
        if not resource or job.lock_state != "held":
            return
        next_job_id, detail = mutexes.release(resource, job.job_id, rank_for)
        job.lock_state = "released"
        add_event(time, "Mutex unlock", job.task.name, detail)
        if next_job_id:
            waiting_job = jobs_by_id[next_job_id]
            waiting_job.blocked = False
            waiting_job.lock_state = "held"
            waiting_job.lock_remaining = waiting_job.task.resource_hold_time
            if algorithm_key == "RR":
                remove_from_rr(next_job_id)
                rr_queue.appendleft(next_job_id)
            elif algorithm_key == "MLFQ":
                enqueue_mlfq(waiting_job)
            add_event(time, "Mutex handoff", waiting_job.task.name,
                      f"{resource} handed off; blocked job is ready.")

    for time in range(duration):
        mark_deadlines(time)
        release_jobs(time)

        if algorithm_key == "MLFQ" and time > 0 and time % boost_interval == 0:
            active_jobs = sorted(
                (job for job in jobs if job.completed_at is None and job.remaining > 0),
                key=lambda job: job.mlfq_queue_order,
            )
            for job in active_jobs:
                old_level = job.mlfq_level
                job.mlfq_level = 0
                job.mlfq_quantum_used = 0
                enqueue_mlfq(job)
                add_event(
                    time,
                    "MLFQ boost",
                    job.task.name,
                    f"Moved from level {old_level} to level 0; quantum counter reset.",
                )

        if priority_inheritance and _applies_priority_inheritance(algorithm_key):
            boosts = mutexes.inherited_ranks(rank_for)
            current_boosts = set(boosts)
            for job_id in current_boosts - prior_boosts:
                add_event(time, "Priority inheritance", jobs_by_id[job_id].task.name,
                          "Effective priority raised while a higher-urgency job waits.")
            for job_id in prior_boosts - current_boosts:
                if job_id in jobs_by_id:
                    add_event(time, "Priority inheritance ended", jobs_by_id[job_id].task.name,
                              "Original scheduling priority restored.")
            prior_boosts = current_boosts
        else:
            prior_boosts = set()

        ready = [job for job in jobs if job.completed_at is None and not job.blocked and job.remaining > 0]
        selected: Optional[_Job] = None
        while ready:
            candidate = select_for_algorithm(ready, time)
            if candidate is None:
                break
            if acquire_if_needed(candidate, time):
                selected = candidate
                break
            ready.remove(candidate)

        if selected is None:
            idle_tick = {"time": time, "task": None, "job_id": None}
            if algorithm_key == "MLFQ":
                idle_tick["mlfq_level"] = None
            timeline.append(idle_tick)
            if previous_running is not None:
                previous_job = jobs_by_id[previous_running]
                if previous_job.completed_at is None and not previous_job.blocked:
                    add_event(time, "Preemption", previous_job.task.name, "CPU became idle or execution was blocked.")
            previous_running = None
            if algorithm_key == "RR":
                rr_current = None
                rr_elapsed = 0
            continue

        if previous_running and previous_running != selected.job_id:
            prior_job = jobs_by_id[previous_running]
            if prior_job.completed_at is None and not prior_job.blocked:
                add_event(time, "Preemption", prior_job.task.name, f"Preempted by {selected.task.name}.")
            if prior_job.completed_at is None and selected.job_id != previous_running:
                context_switches += 1
        elif previous_running is None and selected.job_id:
            pass

        if selected.started_at is None:
            selected.started_at = time
        selected.waiting_time = max(0, time - (selected.started_at if selected.started_at is not None else selected.release))
        timeline_tick = {"time": time, "task": selected.task.name, "job_id": selected.job_id}
        if algorithm_key == "MLFQ":
            timeline_tick["mlfq_level"] = selected.mlfq_level
        timeline.append(timeline_tick)
        selected.remaining -= 1
        if selected.lock_state == "held":
            selected.lock_remaining -= 1
            if selected.lock_remaining == 0:
                release_mutex(selected, time + 1)

        if algorithm_key == "RR":
            if selected.job_id != rr_current and selected.job_id not in prior_boosts:
                rr_current = selected.job_id
                rr_elapsed = 0
            if selected.job_id not in prior_boosts:
                rr_elapsed += 1

        if algorithm_key == "MLFQ":
            selected.mlfq_quantum_used += 1

        if selected.remaining == 0:
            selected.completed_at = time + 1
            add_event(time + 1, "Completion", selected.task.name,
                      f"Job completed; response time {selected.completed_at - selected.release} ticks.")
            release_mutex(selected, time + 1)
            remove_from_rr(selected.job_id)
            if rr_current == selected.job_id:
                rr_current = None
                rr_elapsed = 0

        if algorithm_key == "MLFQ" and selected.completed_at is None:
            quantum = mlfq_quanta[selected.mlfq_level]
            if selected.mlfq_quantum_used >= quantum:
                old_level = selected.mlfq_level
                selected.mlfq_level = min(2, old_level + 1)
                selected.mlfq_quantum_used = 0
                enqueue_mlfq(selected)
                add_event(
                    time + 1,
                    "MLFQ demotion",
                    selected.task.name,
                    f"Quantum expired at level {old_level}; moved to level {selected.mlfq_level} and queued at the back.",
                )

        if algorithm_key == "RR" and selected.completed_at is None and selected.job_id not in prior_boosts:
            if rr_elapsed >= time_quantum:
                if rr_queue and rr_queue[0] == selected.job_id:
                    rr_queue.rotate(-1)
                rr_current = None
                rr_elapsed = 0

        previous_running = selected.job_id if selected.completed_at is None else None

    mark_deadlines(duration)
    job_rows = []
    for job in jobs:
        row = {
            "job_id": job.job_id,
            "task_name": job.task.name,
            "release": job.release,
            "deadline": job.deadline,
            "completion": job.completed_at,
            "response_time": (job.completed_at - job.release) if job.completed_at is not None else None,
            "missed": job.missed,
            "remaining": job.remaining,
        }
        if algorithm_key == "MLFQ":
            row["mlfq_level"] = job.mlfq_level
            row["mlfq_quantum_used"] = job.mlfq_quantum_used
        job_rows.append(row)
    result = {
        "algorithm": _algorithm_label(algorithm_key),
        "algorithm_key": algorithm_key,
        "duration": duration,
        "tasks": task_list,
        "timeline": timeline,
        "events": events,
        "jobs": job_rows,
        "context_switches": context_switches,
        "priority_inheritance": priority_inheritance,
    }
    metrics = calculate_metrics(result)
    if not task_list:
        metrics["schedulability"] = "No tasks"
    elif algorithm_key == "RM":
        task_count = len(task_list)
        bound = task_count * (2 ** (1 / task_count) - 1)
        metrics["schedulability"] = "Pass" if metrics["task_set_utilization"] <= bound else "Fail"
        metrics["schedulability_bound"] = bound
    elif algorithm_key == "EDF":
        metrics["schedulability"] = "Pass" if metrics["task_set_utilization"] <= 1 else "Fail"
        metrics["schedulability_bound"] = 1.0
    else:
        metrics["schedulability"] = "Not applicable"
    result["metrics"] = metrics
    return result
