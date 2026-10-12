"""Built-in autonomous-driving task sets."""

from ..core.task import Task


def default_tasks() -> list[Task]:
    """Return the representative autonomous-driving workload."""
    return [
        Task("Emergency Braking", 20, 3, 20, 1, "Safety-Critical", "SensorBus", 1),
        Task("Obstacle Avoidance", 40, 8, 40, 2, "Safety-Critical"),
        Task("Lane Detection", 50, 10, 50, 3, "Safety-Critical"),
        Task("Sensor Fusion", 100, 15, 100, 4, "Safety-Critical"),
        Task("Infotainment", 200, 30, 200, 5, "Non-Critical", "SensorBus", 10),
    ]


def priority_inversion_tasks() -> list[Task]:
    """Return a staged low/high/medium workload that exposes inversion."""
    return [
        Task("Emergency Braking", 20, 3, 12, 1, "Safety-Critical", "SensorBus", 1, 2),
        Task("Obstacle Avoidance", 30, 8, 30, 2, "Safety-Critical", None, 0, 4),
        Task("Infotainment", 100, 12, 100, 5, "Non-Critical", "SensorBus", 8, 0),
    ]
