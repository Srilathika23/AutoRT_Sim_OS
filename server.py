from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from autort_sim.core.simulator import ALGORITHM_GROUPS, ALGORITHM_REGISTRY, ALGORITHMS, run_simulation
from autort_sim.core.task import Task
from autort_sim.scenarios.default_tasks import default_tasks, priority_inversion_tasks

ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT_DIR / "frontend"


class TaskPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    period: int = Field(gt=0)
    execution_time: int = Field(gt=0)
    relative_deadline: int = Field(gt=0)
    priority: int = Field(default=1, gt=0)
    criticality: Literal["Safety-Critical", "Non-Critical"] = "Safety-Critical"
    shared_resource: str | None = None
    resource_hold_time: int = Field(default=0, ge=0)
    release_offset: int = Field(default=0, ge=0)

    @field_validator("shared_resource")
    @classmethod
    def normalize_resource(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    def to_task(self) -> Task:
        return Task(
            name=self.name,
            period=self.period,
            execution_time=self.execution_time,
            relative_deadline=self.relative_deadline,
            priority=self.priority,
            criticality=self.criticality,
            shared_resource=self.shared_resource,
            resource_hold_time=self.resource_hold_time,
            release_offset=self.release_offset,
        )


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tasks: list[TaskPayload]
    algorithm: str = "RM"
    quantum: int = Field(default=2, gt=0)
    sim_length: int = Field(default=100, gt=0)
    priority_inheritance: bool = False
    params: dict[str, Any] = Field(default_factory=dict)


class CompareRequest(SimulateRequest):
    algorithms: list[str] = Field(default_factory=lambda: list(ALGORITHMS))


class DemoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    algorithm: str = "PRIORITY_P"


app = FastAPI(title="AutoRT-Sim API", version="1.0.0")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": exc.errors()})


def serialize_task(task: Task) -> dict[str, Any]:
    payload = asdict(task)
    payload["shared_resource"] = task.shared_resource
    return payload


def serialize_result(result: dict[str, Any]) -> dict[str, Any]:
    serialized = deepcopy(result)
    serialized["tasks"] = [serialize_task(task) for task in result["tasks"]]
    serialized["jobs"] = [dict(job) for job in result["jobs"]]
    serialized["timeline"] = [dict(item) for item in result["timeline"]]
    serialized["events"] = [dict(event) for event in result["events"]]
    if "metrics" in serialized and isinstance(serialized["metrics"], dict):
        serialized["metrics"] = deepcopy(serialized["metrics"])
    return serialized


def validate_tasks(tasks: list[TaskPayload]) -> list[Task]:
    converted = [task.to_task() for task in tasks]
    names = {task.name.casefold() for task in converted}
    if len(names) != len(converted):
        raise HTTPException(status_code=400, detail="Task names must be unique.")
    return converted


@app.get("/api/default-tasks")
def get_default_tasks() -> dict[str, list[dict[str, Any]]]:
    tasks = [serialize_task(task) for task in default_tasks()]
    return {"tasks": tasks}


@app.get("/api/algorithms")
def get_algorithms() -> dict[str, Any]:
    algorithms = [
        {
            "key": key,
            "label": entry["label"],
            "group": entry["group"],
            "preemptive": entry["preemptive"],
            "extra_params": entry["extra_params"],
        }
        for key, entry in ALGORITHM_REGISTRY.items()
    ]
    groups = [
        {"name": name, "algorithms": [item for item in algorithms if item["group"] == name]}
        for name in ALGORITHM_GROUPS
    ]
    return {"algorithms": algorithms, "groups": groups}


@app.post("/api/simulate")
def simulate(request: SimulateRequest) -> dict[str, Any]:
    try:
        task_list = validate_tasks(request.tasks)
        result = run_simulation(
            tasks=task_list,
            algorithm=request.algorithm,
            duration=int(request.sim_length),
            time_quantum=int(request.quantum),
            priority_inheritance=bool(request.priority_inheritance),
            params=request.params,
        )
        serialized = serialize_result(result)
        return serialized
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/compare")
def compare(request: CompareRequest) -> dict[str, Any]:
    try:
        task_list = validate_tasks(request.tasks)
        requested = list(dict.fromkeys(request.algorithms))
        invalid = [algorithm for algorithm in requested if algorithm not in ALGORITHMS]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Unsupported algorithms: {', '.join(invalid)}.")
        if not requested:
            raise HTTPException(status_code=400, detail="Select at least one algorithm.")
        results = []
        for algorithm in requested:
            result = run_simulation(
                tasks=task_list,
                algorithm=algorithm,
                duration=int(request.sim_length),
                time_quantum=int(request.quantum),
                priority_inheritance=bool(request.priority_inheritance),
                params=request.params,
            )
            results.append(serialize_result(result))

        summary = [
            {
                "algorithm": item["algorithm"],
                "algorithm_key": item["algorithm_key"],
                "group": ALGORITHM_REGISTRY[item["algorithm_key"]]["group"],
                "deadline_misses": item["metrics"]["total_deadline_misses"],
                "cpu_utilization": item["metrics"]["cpu_utilization"],
                "context_switches": item["metrics"]["context_switches"],
                "schedulable": item["metrics"].get("schedulability", "Unknown"),
                "deadline_miss_ratio": item["metrics"]["deadline_miss_ratio"],
                "average_response_time": _average_response_time(item),
            }
            for item in results
        ]
        best = min(summary, key=lambda row: (row["deadline_misses"], row["context_switches"]))
        best["is_best"] = True
        for row in summary:
            if row is not best:
                row["is_best"] = False
        return {"results": results, "summary": summary}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _average_response_time(result: dict[str, Any]) -> float | None:
    values = [
        row["average_response_time"]
        for row in result["metrics"]["per_task"].values()
        if row["average_response_time"] is not None
    ]
    return sum(values) / len(values) if values else None


@app.post("/api/priority-inversion-demo")
def priority_inversion_demo(request: DemoRequest | None = None) -> dict[str, Any]:
    algorithm = request.algorithm if request else "PRIORITY_P"
    allowed = {"PRIORITY_NP", "PRIORITY_P", "PRIORITY_AGING", "RM"}
    if algorithm not in allowed:
        raise HTTPException(status_code=400, detail=f"Demo algorithm must be one of: {', '.join(sorted(allowed))}.")
    tasks = priority_inversion_tasks()
    without = run_simulation(tasks, algorithm, 24, 2, False)
    with_inheritance = run_simulation(tasks, algorithm, 24, 2, True)
    without_serialized = serialize_result(without)
    with_serialized = serialize_result(with_inheritance)
    without_misses = without_serialized["metrics"]["per_task"].get("Emergency Braking", {}).get("deadline_misses", 0)
    with_misses = with_serialized["metrics"]["per_task"].get("Emergency Braking", {}).get("deadline_misses", 0)
    result_line = f"Emergency Braking: {'MISSED' if without_misses else 'MET'} -> {'MISSED' if with_misses else 'MET'}"
    explanation = (
        "Infotainment acquires the shared bus first. Emergency Braking then gets blocked while a medium-priority task runs,"
        " causing the safety-critical job to miss its deadline when priority inheritance is off."
        " With inheritance enabled, the mutex owner temporarily inherits the waiting task’s urgency so the shared resource is released sooner and the deadline is met."
    )
    return {
        "algorithm": algorithm,
        "without_inheritance": without_serialized,
        "with_inheritance": with_serialized,
        "result_line": result_line,
        "explanation": explanation,
        "tasks": [serialize_task(task) for task in tasks],
    }


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
