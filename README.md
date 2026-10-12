# AutoRT-Sim

AutoRT-Sim is a real-time scheduling simulator for autonomous-driving workloads. It combines periodic task modeling, CPU scheduling policy comparison, synchronization analysis, and a lightweight web frontend to help visualize how priority inversion and priority inheritance affect safety-critical systems.

## Project overview

This project includes:

- A core simulation engine in the `autort_sim/core` package
- A Streamlit backup app in `autort_sim/app.py`
- A FastAPI backend in `server.py`
- A clean vanilla JavaScript frontend in `frontend/`

The simulator exposes 11 scheduling policies through a metadata registry:

- **Basic:** FCFS, SJF, SRTF
- **Priority-based:** PRIORITY_NP, PRIORITY_P, PRIORITY_AGING
- **Time-sliced:** RR, MLQ, MLFQ
- **Real-time:** RM, EDF
- Optional priority inheritance on shared resources
- Deadline-miss detection, response-time metrics, and schedulability indicators
- Selectable algorithm comparison and configurable priority-inversion demonstration
- Offline vanilla JavaScript dashboard with SVG timelines, playback, keyboard shortcuts, and JSON/PNG exports

## Novelty statement

> AutoRT-Sim applies classic CPU scheduling algorithms and real-time schedulers to a safety-critical autonomous-driving workload, shows how general-purpose schedulers can miss deadlines of critical tasks, and demonstrates priority inversion through a shared mutex and its fix with priority inheritance.

## Architecture

- `autort_sim/core/task.py`: task model
- `autort_sim/core/schedulers.py`: per-policy ordering helpers and hyperperiod calculation
- `autort_sim/core/resources.py`: mutex and priority-inheritance logic
- `autort_sim/core/simulator.py`: tick-based scheduler engine
- `autort_sim/core/metrics.py`: metrics aggregation
- `autort_sim/scenarios/default_tasks.py`: preset workloads
- `server.py`: FastAPI API and static frontend delivery
- `frontend/`: HTML, CSS, and JavaScript UI

## API

- `GET /api/algorithms`: grouped registry metadata for all 11 policies
- `GET /api/default-tasks`: default autonomous-driving workload
- `POST /api/simulate`: one result, accepting `tasks`, `algorithm`, `quantum`, `sim_length`, `priority_inheritance`, and optional `params`
- `POST /api/compare`: selected policies in `algorithms`, returning full results plus a sortable summary
- `POST /api/priority-inversion-demo`: paired results with and without inheritance; accepts `PRIORITY_NP`, `PRIORITY_P`, `PRIORITY_AGING`, or `RM`

## Run the backend and frontend

From the project root:

```powershell
cd "C:\Users\srila\Downloads\OS project"
python -m venv .venv
\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8012 --reload
```

Then open:

```text
http://127.0.0.1:8012/
```

## Run the Streamlit backup

```powershell
cd "C:\Users\srila\Downloads\OS project"
\.venv\Scripts\Activate.ps1
streamlit run autort_sim\app.py
```

## Run the unit tests

```powershell
cd "C:\Users\srila\Downloads\OS project"
\.venv\Scripts\Activate.ps1
python -m pytest -q autort_sim\tests\test_schedulers.py
```

## Notes

The front-end uses the same underlying scheduling engine as the existing simulator; it does not reimplement the logic. It consumes the exact `run_simulation` result object and only presents the metrics and timeline cleanly in the browser.
