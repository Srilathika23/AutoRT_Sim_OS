"""Streamlit interface for AutoRT-Sim."""

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import streamlit as st
from matplotlib.lines import Line2D

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT.parent) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT.parent))

from autort_sim.core.schedulers import hyperperiod
from autort_sim.core.simulator import ALGORITHMS, run_simulation
from autort_sim.core.task import Task
from autort_sim.scenarios.default_tasks import default_tasks, priority_inversion_tasks

st.set_page_config(page_title="AutoRT-Sim", page_icon="🚗", layout="wide")
st.title("AutoRT-Sim")
st.caption("Real-time scheduling for autonomous driving workloads")


def frame_for(tasks: list[Task]) -> pd.DataFrame:
    """Convert task objects to the editable table representation."""
    return pd.DataFrame([
        {
            "name": task.name,
            "period": task.period,
            "execution_time": task.execution_time,
            "relative_deadline": task.relative_deadline,
            "priority": task.priority,
            "criticality": task.criticality,
            "shared_resource": task.shared_resource or "",
            "resource_hold_time": task.resource_hold_time,
            "release_offset": task.release_offset,
        }
        for task in tasks
    ])


def tasks_from_frame(frame: pd.DataFrame) -> list[Task]:
    """Validate and convert edited table rows into Task instances."""
    tasks: list[Task] = []
    for row in frame.fillna("").to_dict("records"):
        if not str(row["name"]).strip():
            continue
        tasks.append(Task(
            name=str(row["name"]).strip(),
            period=int(row["period"]),
            execution_time=int(row["execution_time"]),
            relative_deadline=int(row["relative_deadline"]),
            priority=int(row["priority"]),
            criticality=str(row["criticality"]),
            shared_resource=str(row["shared_resource"]).strip() or None,
            resource_hold_time=int(row["resource_hold_time"]),
            release_offset=int(row["release_offset"]),
        ))
    if len({task.name.casefold() for task in tasks}) != len(tasks):
        raise ValueError("Task names must be unique.")
    return tasks


def run_chart(result: dict, title: str, axis=None):
    """Draw a per-task Gantt chart with releases and missed deadlines."""
    if axis is None:
        figure, axis = plt.subplots(figsize=(12, max(2.6, len(result["tasks"]) * 0.58)))
    else:
        figure = axis.figure
    tasks = result["tasks"]
    colors = plt.get_cmap("tab10")
    task_rows = {task.name: index for index, task in enumerate(tasks)}
    task_colors = {task.name: colors(index % 10) for index, task in enumerate(tasks)}
    runs = []
    for tick in result["timeline"]:
        name = tick["task"]
        if name is None:
            continue
        if runs and runs[-1]["task"] == name and runs[-1]["end"] == tick["time"]:
            runs[-1]["end"] += 1
        else:
            runs.append({"task": name, "start": tick["time"], "end": tick["time"] + 1})
    for run in runs:
        axis.barh(task_rows[run["task"]], run["end"] - run["start"], left=run["start"],
                  height=0.62, color=task_colors[run["task"]], edgecolor="white", linewidth=0.4)

    for event in result["events"]:
        if event["kind"] == "Release" and event["task"] in task_rows:
            axis.scatter(event["time"], task_rows[event["task"]], marker="|", s=100,
                         color="#202124", linewidths=1.4, zorder=5)
    for job in result["jobs"]:
        if job["missed"] and job["task_name"] in task_rows:
            axis.scatter(min(job["deadline"], result["duration"]), task_rows[job["task_name"]],
                         marker="X", s=65, color="#d62728", zorder=6)

    axis.set_yticks(range(len(tasks)), [task.name for task in tasks])
    axis.set_xlim(0, max(1, result["duration"]))
    axis.set_xlabel("Simulation time (ticks)")
    axis.set_title(title)
    axis.grid(axis="x", alpha=0.2)
    axis.invert_yaxis()
    if not tasks:
        axis.text(0.5, 0.5, "No tasks", ha="center", va="center", transform=axis.transAxes)
    axis.legend(handles=[
        Line2D([0], [0], marker="|", color="white", markeredgecolor="#202124", label="Release", markersize=10),
        Line2D([0], [0], marker="X", color="white", markeredgecolor="#d62728", label="Deadline miss", markersize=7),
    ], loc="upper right", ncol=2, frameon=False)
    return figure


def metrics_frame(result: dict) -> pd.DataFrame:
    """Present the requested task-level metrics as a table."""
    metric = result["metrics"]
    rows = []
    for task in result["tasks"]:
        values = metric["per_task"][task.name]
        rows.append({
            "Task": task.name,
            "Criticality": task.criticality,
            "Deadline misses": values["deadline_misses"],
            "Avg response (ticks)": values["average_response_time"],
            "Worst response (ticks)": values["worst_case_response_time"],
        })
    return pd.DataFrame(rows)


def show_result(result: dict) -> None:
    """Render one result's chart, metrics, and event log."""
    metrics = result["metrics"]
    first, second, third, fourth = st.columns(4)
    first.metric("Deadline misses", metrics["total_deadline_misses"])
    second.metric("CPU utilization", f"{metrics['cpu_utilization']:.1f}%")
    third.metric("Context switches", metrics["context_switches"])
    fourth.metric("Schedulability", metrics["schedulability"])
    st.pyplot(run_chart(result, result["algorithm"]), clear_figure=True)
    st.dataframe(metrics_frame(result), use_container_width=True, hide_index=True)
    st.caption(
        f"Task-set utilization: {metrics['task_set_utilization']:.3f} | "
        f"Deadline-miss ratio: {metrics['deadline_miss_ratio']:.1%}"
    )
    event_rows = [event for event in result["events"] if event["kind"] not in {"Release", "Completion"}]
    with st.expander(f"Event log ({len(result['events'])} total events)"):
        st.dataframe(pd.DataFrame(event_rows), use_container_width=True, hide_index=True)


with st.sidebar:
    st.header("Simulation")
    algorithm = st.selectbox("Algorithm", ALGORITHMS)
    quantum = st.number_input("RR time quantum", min_value=1, max_value=100, value=2)
    run_tasks = st.checkbox("Use priority-inversion demo task set", value=False)
    seed_tasks = priority_inversion_tasks() if run_tasks else default_tasks()
    if "tasks_table" not in st.session_state:
        st.session_state.tasks_table = frame_for(seed_tasks)
    if st.button("Load default tasks"):
        st.session_state.tasks_table = frame_for(default_tasks())
    if st.button("Load inversion demo"):
        st.session_state.tasks_table = frame_for(priority_inversion_tasks())
    default_duration = hyperperiod(seed_tasks)
    duration = st.number_input("Simulation length (ticks)", min_value=1, max_value=1000,
                               value=min(1000, max(1, default_duration)))
    inheritance = st.toggle("Enable Priority Inheritance", value=False)
    st.caption("Task table supports adding, editing, and removing rows.")

st.subheader("Task Set")
columns = ["name", "period", "execution_time", "relative_deadline", "priority", "criticality",
           "shared_resource", "resource_hold_time", "release_offset"]
edited = st.data_editor(
    st.session_state.tasks_table,
    num_rows="dynamic",
    use_container_width=True,
    hide_index=True,
    column_config={
        "period": st.column_config.NumberColumn(min_value=1, step=1),
        "execution_time": st.column_config.NumberColumn(min_value=1, step=1),
        "relative_deadline": st.column_config.NumberColumn(min_value=1, step=1),
        "priority": st.column_config.NumberColumn(min_value=1, step=1),
        "criticality": st.column_config.SelectboxColumn(options=["Safety-Critical", "Non-Critical"]),
        "resource_hold_time": st.column_config.NumberColumn(min_value=0, step=1),
        "release_offset": st.column_config.NumberColumn(min_value=0, step=1),
    },
    key="task_editor",
)
st.session_state.tasks_table = edited

try:
    tasks = tasks_from_frame(edited)
    utilization = sum(task.utilization for task in tasks)
    if utilization > 1:
        st.warning(f"Offered task utilization is {utilization:.1%}; the workload exceeds 100% CPU capacity.")
except (ValueError, TypeError, KeyError) as error:
    tasks = []
    st.error(f"Invalid task table: {error}")

run_tab, compare_tab, demo_tab = st.tabs(["Run", "Compare All Algorithms", "Priority Inversion Demo"])
with run_tab:
    if st.button("Run Simulation", type="primary", disabled=bool(not tasks and len(edited))):
        try:
            result = run_simulation(tasks, algorithm, int(duration), int(quantum), inheritance)
            st.session_state.last_result = result
        except ValueError as error:
            st.error(str(error))
    if "last_result" in st.session_state:
        show_result(st.session_state.last_result)
    elif not tasks:
        st.info("Add at least one valid task, or run with an empty task set to inspect the idle CPU.")

with compare_tab:
    st.write("All three algorithms use the same task set, duration, and inheritance setting.")
    if st.button("Compare All Algorithms"):
        try:
            results = [run_simulation(tasks, name, int(duration), int(quantum), inheritance)
                       for name in ALGORITHMS]
            summary = pd.DataFrame([{
                "Algorithm": result["algorithm"],
                "Deadline misses": result["metrics"]["total_deadline_misses"],
                "Miss ratio": result["metrics"]["deadline_miss_ratio"],
                "CPU utilization": result["metrics"]["cpu_utilization"],
                "Context switches": result["metrics"]["context_switches"],
                "Schedulability": result["metrics"]["schedulability"],
            } for result in results])
            st.session_state.comparison = (results, summary)
        except ValueError as error:
            st.error(str(error))
    if "comparison" in st.session_state:
        results, summary = st.session_state.comparison
        st.dataframe(summary, use_container_width=True, hide_index=True)
        figure, axis = plt.subplots(figsize=(8, 4))
        axis.bar(summary["Algorithm"], summary["Deadline misses"], color=["#4c78a8", "#f2a541", "#59a14f"])
        axis.set_ylabel("Deadline misses")
        axis.grid(axis="y", alpha=0.2)
        st.pyplot(figure, clear_figure=True)
        with st.expander("View individual algorithm timelines"):
            for result in results:
                st.pyplot(run_chart(result, result["algorithm"]), clear_figure=True)

with demo_tab:
    st.write(
        "Infotainment acquires SensorBus first. Emergency Braking then blocks on that mutex, "
        "while Obstacle Avoidance is released and can preempt the low-priority owner. Without "
        "inheritance, the medium-priority work delays the mutex release; with inheritance, "
        "Infotainment temporarily inherits the waiting safety task's urgency and releases the "
        "bus sooner. This staged demonstration uses a shorter emergency deadline to make the "
        "deadline effect visible."
    )
    demo_tasks = priority_inversion_tasks()
    demo_duration = 24
    demo_off, demo_on = st.columns(2)
    demo_results = [
        run_simulation(demo_tasks, "Rate-Monotonic", demo_duration, int(quantum), False),
        run_simulation(demo_tasks, "Rate-Monotonic", demo_duration, int(quantum), True),
    ]
    for target, result, label in zip((demo_off, demo_on), demo_results,
                                     ("Inheritance OFF", "Inheritance ON")):
        with target:
            st.subheader(label)
            st.metric("Deadline misses", result["metrics"]["total_deadline_misses"])
            st.pyplot(run_chart(result, label), clear_figure=True)
    st.dataframe(pd.DataFrame([{
        "Mode": label,
        "Deadline misses": result["metrics"]["total_deadline_misses"],
        "Context switches": result["metrics"]["context_switches"],
    } for label, result in zip(("Inheritance OFF", "Inheritance ON"), demo_results)]),
        use_container_width=True, hide_index=True)
