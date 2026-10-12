"""Task definitions and validation for the scheduling simulator."""

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Task:
    """A periodic real-time task and its optional mutex usage."""

    name: str
    period: int
    execution_time: int
    relative_deadline: int
    priority: int = 1
    criticality: str = "Safety-Critical"
    shared_resource: Optional[str] = None
    resource_hold_time: int = 0
    release_offset: int = 0

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("Task name cannot be empty.")
        if self.period <= 0:
            raise ValueError(f"{self.name}: period must be positive.")
        if self.execution_time <= 0:
            raise ValueError(f"{self.name}: execution time must be positive.")
        if self.relative_deadline <= 0:
            raise ValueError(f"{self.name}: relative deadline must be positive.")
        if self.priority <= 0:
            raise ValueError(f"{self.name}: priority must be positive.")
        if self.criticality not in {"Safety-Critical", "Non-Critical"}:
            raise ValueError(f"{self.name}: unsupported criticality.")
        if self.release_offset < 0:
            raise ValueError(f"{self.name}: release offset cannot be negative.")
        if self.resource_hold_time < 0:
            raise ValueError(f"{self.name}: resource hold time cannot be negative.")
        if self.resource_hold_time and not self.shared_resource:
            raise ValueError(f"{self.name}: a hold time requires a shared resource.")
        if self.resource_hold_time > self.execution_time:
            raise ValueError(f"{self.name}: resource hold time cannot exceed execution time.")

    @property
    def utilization(self) -> float:
        """Return the task's utilization contribution, C/T."""
        return self.execution_time / self.period
