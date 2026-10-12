"""Tests for scheduler ordering, deadline detection, and inheritance."""

from math import isfinite
from types import SimpleNamespace

import pytest

from autort_sim.core.schedulers import (
    edf_order,
    fcfs_order,
    mlfq_order,
    mlq_order,
    priority_aging_order,
    priority_np_order,
    priority_p_order,
    rm_order,
    sjf_order,
    srtf_order,
)
from autort_sim.core.simulator import ALGORITHM_REGISTRY, ALGORITHMS, run_simulation
from autort_sim.core.task import Task
from autort_sim.scenarios.default_tasks import default_tasks, priority_inversion_tasks


def _job(
    name: str,
    *,
    execution_time: int = 1,
    priority: int = 1,
    criticality: str = "Safety-Critical",
    release: int = 0,
    deadline: int = 20,
    remaining: int | None = None,
    waiting_time: int = 0,
    mlfq_level: int = 0,
) -> SimpleNamespace:
    task = Task(name, 30, execution_time, deadline, priority, criticality)
    return SimpleNamespace(
        task=task,
        task_name=name,
        release=release,
        deadline=deadline,
        remaining=execution_time if remaining is None else remaining,
        waiting_time=waiting_time,
        mlfq_level=mlfq_level,
    )


@pytest.mark.parametrize(
    ("algorithm", "orderer", "jobs", "kwargs", "expected"),
    [
        (
            "FCFS",
            fcfs_order,
            [_job("last", release=2), _job("first", release=0), _job("middle", release=1)],
            {},
            ["first", "middle", "last"],
        ),
        (
            "SJF",
            sjf_order,
            [_job("long", execution_time=5), _job("short", execution_time=1), _job("mid", execution_time=3)],
            {},
            ["short", "mid", "long"],
        ),
        (
            "SRTF",
            srtf_order,
            [_job("long", remaining=5), _job("short", remaining=1), _job("mid", remaining=3)],
            {},
            ["short", "mid", "long"],
        ),
        (
            "PRIORITY_NP",
            priority_np_order,
            [_job("low", priority=5), _job("high", priority=1), _job("medium", priority=3)],
            {},
            ["high", "medium", "low"],
        ),
        (
            "PRIORITY_P",
            priority_p_order,
            [_job("low", priority=5), _job("high", priority=1), _job("medium", priority=3)],
            {},
            ["high", "medium", "low"],
        ),
        (
            "PRIORITY_AGING",
            priority_aging_order,
            [
                _job("aged", priority=1, waiting_time=10, release=2),
                _job("fresh", priority=2, waiting_time=0, release=0),
                _job("mid", priority=1, waiting_time=5, release=1),
            ],
            {"aging_interval": 5},
            ["fresh", "mid", "aged"],
        ),
        (
            "MLQ",
            mlq_order,
            [
                _job("normal-first", criticality="Non-Critical", release=0),
                _job("safety-later", criticality="Safety-Critical", release=2),
                _job("normal-later", criticality="Non-Critical", release=1),
            ],
            {},
            ["safety-later", "normal-first", "normal-later"],
        ),
        (
            "MLFQ",
            mlfq_order,
            [
                _job("low", mlfq_level=2),
                _job("high", mlfq_level=0),
                _job("mid", mlfq_level=1),
            ],
            {"quanta": (2, 4, 8)},
            ["high", "mid", "low"],
        ),
    ],
)
def test_requested_scheduler_orders_handmade_jobs(algorithm, orderer, jobs, kwargs, expected) -> None:
    assert [job.task_name for job in orderer(jobs, **kwargs)] == expected
    assert algorithm in ALGORITHM_REGISTRY


@pytest.mark.parametrize(
    ("algorithm", "declared_preemptive", "task_at_tick_two"),
    [
        ("FCFS", False, "Long"),
        ("SJF", False, "Long"),
        ("SRTF", True, "Urgent"),
        ("PRIORITY_NP", False, "Long"),
        ("PRIORITY_P", True, "Urgent"),
        ("PRIORITY_AGING", True, "Urgent"),
        ("MLQ", True, "Urgent"),
        ("MLFQ", True, "Urgent"),
    ],
)
def test_requested_scheduler_preemption_behavior(algorithm, declared_preemptive, task_at_tick_two) -> None:
    tasks = [
        Task("Long", 30, 6, 30, 5, "Non-Critical"),
        Task("Urgent", 30, 1, 20, 1, "Safety-Critical", release_offset=2),
    ]

    result = run_simulation(tasks, algorithm, duration=9, params={"aging_interval": 5})

    assert ALGORITHM_REGISTRY[algorithm]["preemptive"] is declared_preemptive
    assert result["timeline"][2]["task"] == task_at_tick_two
    if task_at_tick_two == "Urgent":
        assert result["timeline"][3]["task"] == "Long"
        if algorithm == "MLFQ":
            assert result["timeline"][2]["mlfq_level"] == 0
    else:
        assert all(tick["task"] == "Long" for tick in result["timeline"][:6])


@pytest.mark.parametrize(
    "algorithm",
    ["FCFS", "SJF", "SRTF", "PRIORITY_NP", "PRIORITY_P", "PRIORITY_AGING", "MLQ", "MLFQ"],
)
def test_requested_scheduler_metrics_are_sane(algorithm: str) -> None:
    tasks = [
        Task("Long", 30, 6, 30, 5, "Non-Critical"),
        Task("Urgent", 30, 1, 20, 1, "Safety-Critical", release_offset=2),
    ]

    result = run_simulation(tasks, algorithm, duration=9, params={"aging_interval": 5})
    metrics = result["metrics"]

    assert result["algorithm_key"] == algorithm
    assert metrics["total_jobs"] == len(result["jobs"]) > 0
    assert 0 <= metrics["total_deadline_misses"] <= metrics["total_jobs"]
    assert 0 <= metrics["deadline_miss_ratio"] <= 1
    assert 0 <= metrics["cpu_utilization"] <= 100
    assert isfinite(metrics["task_set_utilization"])
    assert metrics["context_switches"] == result["context_switches"]
    assert set(metrics["per_task"]) == {task.name for task in tasks}


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_every_registered_algorithm_runs_default_workload(algorithm: str) -> None:
    result = run_simulation(
        default_tasks(),
        algorithm,
        duration=100,
        params={"aging_interval": 5, "boost_interval": 20, "mlfq_quanta": (2, 4, 8)},
    )
    metrics = result["metrics"]

    assert result["algorithm_key"] == algorithm
    assert len(result["timeline"]) == result["duration"]
    assert metrics["total_jobs"] == len(result["jobs"]) > 0
    assert 0 <= metrics["total_deadline_misses"] <= metrics["total_jobs"]
    assert 0 <= metrics["deadline_miss_ratio"] <= 1
    assert 0 <= metrics["cpu_utilization"] <= 100
    assert isfinite(metrics["task_set_utilization"])
    assert metrics["context_switches"] == result["context_switches"]


def test_mlfq_new_level_zero_job_preempts_demoted_long_job() -> None:
    tasks = [
        Task("Long", 20, 8, 20, 5, "Non-Critical"),
        Task("New", 20, 1, 20, 1, "Safety-Critical", release_offset=2),
    ]

    result = run_simulation(
        tasks,
        "MLFQ",
        duration=6,
        params={"mlfq_quanta": (2, 4, 8), "boost_interval": 20},
    )

    assert [tick["task"] for tick in result["timeline"][:2]] == ["Long", "Long"]
    assert result["timeline"][2]["task"] == "New"
    assert result["timeline"][0]["mlfq_level"] == 0
    assert result["timeline"][2]["mlfq_level"] == 0


def test_mlfq_level_one_uses_four_tick_quantum() -> None:
    result = run_simulation(
        [Task("Long", 30, 12, 30)],
        "MLFQ",
        duration=8,
        params={"mlfq_quanta": (2, 4, 8), "boost_interval": 20},
    )

    assert [tick["mlfq_level"] for tick in result["timeline"]] == [0, 0, 1, 1, 1, 1, 2, 2]
    demotions = [event for event in result["events"] if event["kind"] == "MLFQ demotion"]
    assert [(event["time"], event["detail"]) for event in demotions] == [
        (2, "Quantum expired at level 0; moved to level 1 and queued at the back."),
        (6, "Quantum expired at level 1; moved to level 2 and queued at the back."),
    ]


def test_mlfq_boost_resets_level_and_quantum_counter() -> None:
    result = run_simulation(
        [Task("Long", 30, 12, 30)],
        "MLFQ",
        duration=8,
        params={"mlfq_quanta": (2, 4, 8), "boost_interval": 5},
    )

    assert [tick["mlfq_level"] for tick in result["timeline"]] == [0, 0, 1, 1, 1, 0, 0, 1]
    assert any(
        event["time"] == 5
        and event["kind"] == "MLFQ boost"
        and "Moved from level 1 to level 0" in event["detail"]
        for event in result["events"]
    )


def test_mlfq_job_finishing_early_is_not_demoted() -> None:
    result = run_simulation(
        [Task("Short", 10, 1, 10)],
        "MLFQ",
        duration=3,
        params={"mlfq_quanta": (2, 4, 8)},
    )

    assert result["timeline"][0]["mlfq_level"] == 0
    assert result["jobs"][0]["mlfq_level"] == 0
    assert result["jobs"][0]["mlfq_quantum_used"] == 1
    assert not any(event["kind"] == "MLFQ demotion" for event in result["events"])


def test_rm_orders_shorter_period_first() -> None:
    tasks = [Task("slow", 50, 2, 50), Task("fast", 10, 1, 10), Task("mid", 20, 1, 20)]
    assert [task.name for task in rm_order(tasks)] == ["fast", "mid", "slow"]


def test_edf_orders_earliest_absolute_deadline_first() -> None:
    jobs = [
        type("Job", (), {"task_name": "later", "deadline": 12, "priority": 1})(),
        type("Job", (), {"task_name": "soon", "deadline": 5, "priority": 1})(),
    ]
    assert [job.task_name for job in edf_order(jobs)] == ["soon", "later"]


def test_deadline_miss_detected_for_overloaded_task() -> None:
    task = Task("overloaded", 5, 8, 3)
    result = run_simulation([task], "Rate-Monotonic", 10)
    assert result["metrics"]["total_deadline_misses"] >= 1
    assert any(event["kind"] == "Deadline miss" for event in result["events"])


def test_priority_inheritance_reduces_inversion_deadline_miss() -> None:
    tasks = priority_inversion_tasks()
    without = run_simulation(tasks, "Rate-Monotonic", 24, priority_inheritance=False)
    with_inheritance = run_simulation(tasks, "Rate-Monotonic", 24, priority_inheritance=True)
    assert without["metrics"]["per_task"]["Emergency Braking"]["deadline_misses"] == 1
    assert with_inheritance["metrics"]["per_task"]["Emergency Braking"]["deadline_misses"] == 0
    assert any(event["kind"] == "Priority inheritance" for event in with_inheritance["events"])


def test_empty_task_set_is_idle_and_valid() -> None:
    result = run_simulation([], "Earliest Deadline First", 4)
    assert len(result["timeline"]) == 4
    assert all(tick["task"] is None for tick in result["timeline"])
    assert result["metrics"]["schedulability"] == "No tasks"
