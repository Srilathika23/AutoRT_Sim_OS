# AutoRT-Sim

AutoRT-Sim is a real-time scheduling simulator for autonomous-driving workloads, built for an Operating Systems course. It combines discrete-time CPU scheduling, periodic task releases, mutex synchronization, deadline tracking, and a Streamlit comparison interface.

## Novelty

> Standard scheduling simulators treat all tasks equally. AutoRT-Sim models safety-critical vehicular tasks with hard deadlines, shows how a low-priority infotainment task can cause a safety-critical task to miss its deadline through priority inversion, and demonstrates the fix with priority inheritance, with side-by-side comparison of RR, RM, and EDF.

The priority-inversion demo stages Infotainment's mutex acquisition before Emergency Braking and Obstacle Avoidance release. This makes the inversion reproducible; enabling priority inheritance boosts the mutex owner while the safety-critical task is blocked.

## Features

- Round Robin, preemptive Rate-Monotonic, and preemptive Earliest Deadline First.
- One-tick discrete simulation, configurable length up to 1000 ticks, with hyperperiod-based defaults.
- Editable periodic task set with execution times, deadlines, fixed priorities, criticality, release offsets, and optional mutex use.
- Mutex blocking, handoff, priority inheritance, releases, completions, preemptions, and deadline misses in the event log.
- Per-task and total deadline misses, miss ratio, CPU utilization, context switches, response times, and schedulability checks.
- Empty workloads and overloads are supported and explicitly reported.

## Installation and Run

Python 3.10 or newer is required.

```powershell
cd autort_sim
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
streamlit run app.py
```

On macOS or Linux, activate the environment with `source .venv/bin/activate`.

Run the unit tests:

```powershell
python -m pytest -q
```

## Algorithms

### Round Robin (RR)

A ready job runs for up to the configurable time quantum before moving to the end of the ready queue. RR is useful as a baseline for fairness and context-switch behavior; it is not a fixed-priority real-time policy.

### Rate-Monotonic (RM)

A preemptive fixed-priority policy. Tasks with shorter periods have higher priority. The UI reports the Liu-Layland sufficient utilization bound $U \le n(2^{1/n}-1)$; passing this bound is sufficient, not necessary, for schedulability under its standard assumptions.

### Earliest Deadline First (EDF)

A preemptive dynamic-priority policy. The ready job with the nearest absolute deadline runs first. For independent periodic tasks with deadlines equal to periods, utilization $U \le 1$ is the schedulability check reported by this simulator.

## Default Workload

| Task | Period | WCET | Deadline | Criticality | Shared resource |
|---|---:|---:|---:|---|---|
| Emergency Braking | 20 | 3 | 20 | Safety-Critical | SensorBus |
| Obstacle Avoidance | 40 | 8 | 40 | Safety-Critical | None |
| Lane Detection | 50 | 10 | 50 | Safety-Critical | None |
| Sensor Fusion | 100 | 15 | 100 | Safety-Critical | None |
| Infotainment | 200 | 30 | 200 | Non-Critical | SensorBus |

## Screenshots

_Add screenshots here after launching the Streamlit application._

## Project Layout

```text
autort_sim/
  app.py
  requirements.txt
  README.md
  core/
    task.py
    schedulers.py
    resources.py
    simulator.py
    metrics.py
  scenarios/
    default_tasks.py
  tests/
    test_schedulers.py
```
