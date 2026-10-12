"""Metric aggregation for completed simulation results."""

from collections import defaultdict
from typing import Any


def calculate_metrics(result: dict[str, Any]) -> dict[str, Any]:
    """Compute task and run metrics from simulator job records."""
    tasks = result["tasks"]
    jobs = result["jobs"]
    duration = result["duration"]
    per_task: dict[str, dict[str, Any]] = {
        task.name: {"deadline_misses": 0, "response_times": []} for task in tasks
    }
    for job in jobs:
        row = per_task[job["task_name"]]
        if job["missed"]:
            row["deadline_misses"] += 1
        if job["response_time"] is not None:
            row["response_times"].append(job["response_time"])

    for row in per_task.values():
        responses = row.pop("response_times")
        row["average_response_time"] = sum(responses) / len(responses) if responses else None
        row["worst_case_response_time"] = max(responses) if responses else None

    total_jobs = len(jobs)
    total_misses = sum(row["deadline_misses"] for row in per_task.values())
    utilization = sum(task.utilization for task in tasks)
    executed_ticks = sum(1 for tick in result["timeline"] if tick["task"] is not None)
    return {
        "per_task": per_task,
        "total_jobs": total_jobs,
        "total_deadline_misses": total_misses,
        "deadline_miss_ratio": total_misses / total_jobs if total_jobs else 0.0,
        "cpu_utilization": (executed_ticks / duration * 100) if duration else 0.0,
        "task_set_utilization": utilization,
        "context_switches": result["context_switches"],
    }
