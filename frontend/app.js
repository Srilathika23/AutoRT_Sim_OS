(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'autort-sim-settings';
  const GROUP_COLORS = window.AutoRTCharts.groupColors;
  const GROUP_COPY = {
    Basic: 'Classic arrival and burst-time policies. FCFS and SJF keep a running job; SRTF can preempt it when shorter work arrives.',
    'Priority-based': 'Choose by task priority, either with or without preemption. Aging adjusts the effective rank as work waits.',
    'Time-sliced': 'Share processor time in turns or queues. Round Robin is quantum-based; MLQ and MLFQ model queue classes and levels.',
    'Real-time': 'Periodic-task policies designed around timing requirements. RM ranks by period; EDF ranks by absolute deadline.',
  };
  const EVENT_ICONS = {
    Release: '↓', Completion: '✓', 'Deadline miss': '×', Preemption: '↯',
    'Mutex lock': '⌑', 'Mutex unlock': '↗', 'Mutex block': 'Ⅱ', 'Mutex handoff': '⇢',
    'Priority inheritance': '↑', 'Priority inheritance ended': '↘',
  };
  const EVENT_FILTERS = [
    ['All', null], ['Release', 'Release'], ['Completion', 'Completion'], ['Deadline miss', 'Deadline miss'],
    ['Preemption', 'Preemption'], ['Mutex lock', 'Mutex lock'], ['Mutex unlock', 'Mutex unlock'],
    ['Mutex block', 'Mutex block'], ['Mutex handoff', 'Mutex handoff'],
  ];

  let settings = readSettings();
  let tasks = [];
  let algorithms = [];
  let groups = [];
  let lastResult = null;
  let comparePayload = null;
  let demoPayload = null;
  let activeTab = 'simulate';
  let playbackTick = 0;
  let demoTick = 0;
  let playbackTimer = null;
  let demoTimer = null;
  let selectedEventKind = null;
  let compareSort = { key: 'deadline_misses', direction: 'asc' };
  let compareRows = [];

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        algorithm: $('algorithmSelect')?.value || settings.algorithm || 'PRIORITY_P',
        inheritance: Boolean($('inheritanceToggle')?.checked),
        presentation: document.body.classList.contains('presentation-mode'),
      }));
    } catch {
      // Storage may be disabled by the browser; the dashboard remains usable.
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function notify(message, isError = false) {
    const region = $('toastRegion');
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  async function requestJson(path, options = {}) {
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      $('connectionState').className = 'connection-state is-offline';
      $('connectionState').lastElementChild.textContent = 'Backend offline';
      throw new Error('The AutoRT-Sim backend is unreachable. Start the FastAPI server and reload this page.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = Array.isArray(payload.detail)
        ? payload.detail.map((item) => `${(item.loc || []).slice(-1)[0] || 'Input'}: ${item.msg}`).join('; ')
        : payload.detail;
      throw new Error(detail || `Request failed (${response.status}).`);
    }
    $('connectionState').className = 'connection-state is-online';
    $('connectionState').lastElementChild.textContent = 'API connected';
    return payload;
  }

  function setLoading(button, loading, label) {
    button.disabled = loading;
    button.classList.toggle('is-loading', loading);
    button.querySelector('.button-label').textContent = loading ? 'Running…' : label;
  }

  function getAlgorithm(key) {
    return algorithms.find((item) => item.key === key);
  }

  function renderAlgorithmSelect() {
    const select = $('algorithmSelect');
    select.replaceChildren();
    groups.forEach((group) => {
      const optionGroup = document.createElement('optgroup');
      optionGroup.label = group.name;
      group.algorithms.forEach((algorithm) => {
        const option = document.createElement('option');
        option.value = algorithm.key;
        option.textContent = algorithm.label;
        optionGroup.appendChild(option);
      });
      select.appendChild(optionGroup);
    });
    const preferred = algorithms.some((item) => item.key === settings.algorithm) ? settings.algorithm : 'PRIORITY_P';
    select.value = getAlgorithm(preferred) ? preferred : algorithms[0]?.key || '';
    $('inheritanceToggle').checked = Boolean(settings.inheritance);
    if (settings.presentation) togglePresentation(true);
    updateAlgorithmControls();
  }

  function updateAlgorithmControls() {
    const key = $('algorithmSelect').value;
    const algorithm = getAlgorithm(key);
    const extras = algorithm?.extra_params || {};
    $('quantumWrap').classList.toggle('hidden', !['RR'].includes(key));
    $('agingWrap').classList.toggle('hidden', !Object.hasOwn(extras, 'aging_interval'));
    $('boostWrap').classList.toggle('hidden', !Object.hasOwn(extras, 'boost_interval'));
    $('algorithmBadge').textContent = algorithm ? `${algorithm.preemptive ? 'Preemptive' : 'Non-preemptive'} · ${algorithm.group}` : '';
    if (algorithm) $('algorithmBadge').style.color = GROUP_COLORS[algorithm.group] || '';
    saveSettings();
  }

  function renderAboutGroups() {
    $('aboutGroups').innerHTML = groups.map((group) => `
      <article class="group-card" style="border-top:2px solid ${GROUP_COLORS[group.name] || '#22d3ee'}">
        <h3>${escapeHtml(group.name)}</h3>
        <p>${escapeHtml(GROUP_COPY[group.name] || '')}</p>
      </article>`).join('');
  }

  function renderAlgorithmChecks() {
    $('algorithmChecks').innerHTML = groups.map((group) => `
      <section class="algorithm-group" aria-label="${escapeHtml(group.name)} algorithms">
        <h3 style="color:${GROUP_COLORS[group.name] || '#22d3ee'}">${escapeHtml(group.name)}</h3>
        ${group.algorithms.map((algorithm) => `
          <label class="algorithm-option"><input type="checkbox" value="${escapeHtml(algorithm.key)}" checked />
            <span>${escapeHtml(algorithm.label)}</span></label>`).join('')}
      </section>`).join('');
  }

  function defaultTask() {
    return {
      name: '', period: 10, execution_time: 2, relative_deadline: 10, priority: 1,
      criticality: 'Safety-Critical', shared_resource: null, resource_hold_time: 0, release_offset: 0,
    };
  }

  function taskColor(taskName, index = 0) {
    const colors = window.AutoRTGantt.colorMapFor([...tasks, { name: taskName }]);
    return colors.get(taskName) || ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399'][index % 5];
  }

  function renderTaskTable(values = tasks) {
    tasks = values.map((task) => ({ ...task, shared_resource: task.shared_resource || '' }));
    $('taskCount').textContent = String(tasks.length);
    const tbody = $('taskTable').querySelector('tbody');
    tbody.innerHTML = tasks.map((task, index) => `
      <tr data-row="${index}">
        <td><div class="task-name-cell"><i class="task-dot" style="background:${taskColor(task.name, index)};color:${taskColor(task.name, index)}"></i><input data-field="name" aria-label="Task name" value="${escapeHtml(task.name)}" /></div></td>
        <td><input data-field="period" type="number" min="1" aria-label="Period" value="${Number(task.period) || 1}" /></td>
        <td><input data-field="execution_time" type="number" min="1" aria-label="Execution time" value="${Number(task.execution_time) || 1}" /></td>
        <td><input data-field="relative_deadline" type="number" min="1" aria-label="Relative deadline" value="${Number(task.relative_deadline) || 1}" /></td>
        <td><select data-field="criticality" aria-label="Criticality"><option value="Safety-Critical" ${task.criticality === 'Safety-Critical' ? 'selected' : ''}>Safety-Critical</option><option value="Non-Critical" ${task.criticality === 'Non-Critical' ? 'selected' : ''}>Non-Critical</option></select></td>
        <td class="advanced-column"><input data-field="priority" type="number" min="1" aria-label="Priority" value="${Number(task.priority) || 1}" /></td>
        <td class="advanced-column"><input data-field="shared_resource" aria-label="Shared resource" value="${escapeHtml(task.shared_resource || '')}" /></td>
        <td class="advanced-column"><input data-field="resource_hold_time" type="number" min="0" aria-label="Resource hold time" value="${Number(task.resource_hold_time) || 0}" /></td>
        <td class="advanced-column"><input data-field="release_offset" type="number" min="0" aria-label="Release offset" value="${Number(task.release_offset) || 0}" /></td>
        <td><button class="delete-row" type="button" data-delete="${index}" aria-label="Delete ${escapeHtml(task.name || 'task')}" title="Delete task">×</button></td>
      </tr>`).join('');
    document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => {
      const next = readTaskRows().filter((_, index) => index !== Number(button.dataset.delete));
      renderTaskTable(next);
      updateTaskWarnings();
    }));
    updateTaskWarnings();
  }

  function readTaskRows() {
    return [...$('taskTable').querySelectorAll('tbody tr')].map((row) => {
      const value = (field) => row.querySelector(`[data-field="${field}"]`).value;
      return {
        name: value('name').trim(),
        period: Number(value('period')),
        execution_time: Number(value('execution_time')),
        relative_deadline: Number(value('relative_deadline')),
        criticality: value('criticality'),
        priority: Number(value('priority')),
        shared_resource: value('shared_resource').trim() || null,
        resource_hold_time: Number(value('resource_hold_time')),
        release_offset: Number(value('release_offset')),
      };
    });
  }

  function validateTaskRows() {
    const rows = [...$('taskTable').querySelectorAll('tbody tr')];
    const values = readTaskRows();
    const errors = [];
    const seen = new Set();
    rows.forEach((row, index) => {
      const item = values[index];
      row.querySelectorAll('[data-field]').forEach((input) => input.classList.remove('invalid'));
      const fail = (field, message) => {
        row.querySelector(`[data-field="${field}"]`).classList.add('invalid');
        errors.push(message);
      };
      if (!item.name) fail('name', `Row ${index + 1}: task name is required.`);
      const normalized = item.name.toLocaleLowerCase();
      if (item.name && seen.has(normalized)) fail('name', `${item.name}: task names must be unique.`);
      seen.add(normalized);
      ['period', 'execution_time', 'relative_deadline', 'priority'].forEach((field) => {
        if (!Number.isInteger(item[field]) || item[field] <= 0) fail(field, `${item.name || `Row ${index + 1}`}: ${field.replaceAll('_', ' ')} must be a positive integer.`);
      });
      ['resource_hold_time', 'release_offset'].forEach((field) => {
        if (!Number.isInteger(item[field]) || item[field] < 0) fail(field, `${item.name || `Row ${index + 1}`}: ${field.replaceAll('_', ' ')} cannot be negative.`);
      });
      if (item.resource_hold_time > item.execution_time) fail('resource_hold_time', `${item.name}: mutex hold time cannot exceed execution time.`);
      if (item.resource_hold_time && !item.shared_resource) fail('shared_resource', `${item.name}: a mutex hold requires a resource name.`);
    });
    if (!rows.length) errors.push('Add at least one task before running.');
    const length = Number($('simLengthInput').value);
    if (!Number.isInteger(length) || length < 1 || length > 1000) errors.push('Simulation duration must be between 1 and 1000 ticks.');
    $('taskValidation').textContent = errors[0] || '';
    $('taskValidation').classList.toggle('hidden', errors.length === 0);
    return { tasks: values, errors };
  }

  function updateTaskWarnings() {
    const current = readTaskRows().filter((task) => task.name);
    const utilization = current.reduce((sum, task) => sum + ((Number(task.execution_time) || 0) / (Number(task.period) || 1)), 0);
    const warning = $('utilizationWarning');
    warning.textContent = utilization > 1 ? `Offered task utilization is ${(utilization * 100).toFixed(1)}%. The workload exceeds 100% CPU capacity.` : '';
    warning.classList.toggle('hidden', utilization <= 1);
    $('taskCount').textContent = String(current.length);
  }

  function readParams() {
    return {
      aging_interval: Math.max(1, Number($('agingInput').value) || 5),
      boost_interval: Math.max(1, Number($('boostInput').value) || 20),
      mlfq_quanta: [2, 4, 8],
    };
  }

  function simulationRequest(selectedTasks, algorithm = $('algorithmSelect').value) {
    return {
      tasks: selectedTasks,
      algorithm,
      quantum: Math.max(1, Number($('quantumInput').value) || 2),
      sim_length: Math.max(1, Math.min(1000, Number($('simLengthInput').value) || 100)),
      priority_inheritance: $('inheritanceToggle').checked,
      params: readParams(),
    };
  }

  async function runSimulation() {
    const { tasks: selectedTasks, errors } = validateTaskRows();
    if (errors.length) return;
    const button = $('runButton');
    setLoading(button, true, 'Run simulation');
    try {
      const result = await requestJson('/api/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(simulationRequest(selectedTasks)),
      });
      lastResult = result;
      $('simulateError').classList.add('hidden');
      renderSimulationResult(result);
      setActiveTab('simulate');
      notify('Simulation complete.');
    } catch (error) {
      showNotice('simulateError', error.message);
      notify(error.message, true);
    } finally {
      setLoading(button, false, 'Run simulation');
    }
  }

  function showNotice(id, message) {
    const notice = $(id);
    notice.textContent = message;
    notice.classList.toggle('hidden', !message);
  }

  function countUp(element, target, format = (value) => Math.round(value).toLocaleString()) {
    const destination = Number(target) || 0;
    const start = performance.now();
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450;
    function frame(now) {
      const progress = duration ? Math.min(1, (now - start) / duration) : 1;
      const eased = 1 - (1 - progress) ** 3;
      element.textContent = format(destination * eased);
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderSimulationResult(result) {
    const metrics = result.metrics;
    const misses = Number(metrics.total_deadline_misses) || 0;
    $('simulateResults').classList.remove('hidden');
    $('resultTitle').textContent = `${result.algorithm} · ${result.duration} ticks`;
    countUp($('missesStat'), misses);
    countUp($('missRatioStat'), Number(metrics.deadline_miss_ratio) * 100, (value) => `${value.toFixed(1)}%`);
    countUp($('utilizationStat'), Number(metrics.cpu_utilization), (value) => `${value.toFixed(1)}%`);
    countUp($('switchesStat'), Number(metrics.context_switches));
    document.querySelector('.stat-misses').classList.toggle('has-misses', misses > 0);
    document.querySelector('.stat-misses').classList.toggle('is-clear', misses === 0);
    const schedulability = metrics.schedulability || 'Unknown';
    $('schedulableStat').textContent = schedulability;
    $('schedulabilityNote').textContent = metrics.schedulability_bound != null ? `utilization bound ${Number(metrics.schedulability_bound).toFixed(2)}` : 'policy analysis';
    const ring = document.querySelector('.ring-value');
    ring.style.strokeDashoffset = String(100.6 * (1 - Math.min(100, Number(metrics.cpu_utilization) || 0) / 100));
    renderTaskMetrics(result);
    renderEvents(result.events || []);
    drawGantt(result);
    const slider = $('playbackSlider');
    slider.max = String(Math.max(0, result.duration - 1));
    slider.value = '0';
    playbackTick = 0;
    updatePlayback(result, 0);
    $('exportJsonButton').disabled = false;
    $('exportPngButton').disabled = false;
  }

  function renderTaskMetrics(result) {
    const values = result.metrics.per_task || {};
    const maxResponse = Math.max(1, ...Object.values(values).map((row) => Number(row.worst_case_response_time) || 0));
    $('taskMetricsBody').innerHTML = result.tasks.map((task, index) => {
      const row = values[task.name] || {};
      const average = row.average_response_time;
      const width = average == null ? 0 : Math.max(5, (Number(average) / maxResponse) * 100);
      return `<tr><td><span class="policy-label"><i class="task-dot" style="background:${taskColor(task.name, index)}"></i>${escapeHtml(task.name)}</span></td><td>${Number(row.deadline_misses) || 0}</td><td>${average == null ? '—' : `${Number(average).toFixed(1)} ticks`}<span class="response-meter"><i style="width:${width}%;background:${taskColor(task.name, index)}"></i></span></td><td>${row.worst_case_response_time == null ? '—' : `${Number(row.worst_case_response_time)} ticks`}</td></tr>`;
    }).join('');
  }

  function drawGantt(result, target = $('ganttContainer'), options = {}) {
    target.replaceChildren(window.AutoRTGantt.buildGantt(result, {
      scale: Number($('zoomSlider').value) || 18,
      cursor: options.cursor || 0,
      inversionRange: options.inversionRange,
    }));
    if (target === $('ganttContainer')) renderLegend(result);
  }

  function renderLegend(result) {
    const taskList = result.tasks || [];
    const colors = window.AutoRTGantt.colorMapFor(taskList);
    const taskItems = taskList.map((task) => `<span class="legend-item"><i class="task-dot" style="background:${colors.get(task.name)}"></i>${escapeHtml(task.name)}</span>`).join('');
    const levelItems = result.algorithm_key === 'MLFQ'
      ? [0, 1, 2].map((level) => `<span class="legend-item"><i class="task-dot" style="background:${window.AutoRTGantt.shadeForLevel('#22d3ee', level)}"></i>L${level}</span>`).join('')
      : '';
    $('ganttLegend').innerHTML = taskItems + levelItems + '<span class="legend-item"><i class="legend-deadline"></i>Deadline</span><span class="legend-item"><i class="legend-idle"></i>Idle</span>';
  }

  function buildMutexState(result, tick) {
    const owners = new Map();
    const blocked = new Set();
    (result.events || []).filter((event) => event.time <= tick).forEach((event) => {
      if (event.kind === 'Mutex lock') {
        const match = event.detail.match(/^(.+?#\d+) locked (.+)\.$/);
        if (match) owners.set(match[2], match[1]);
      }
      if (event.kind === 'Mutex unlock') {
        const job = event.detail.match(/^(.+?#\d+) unlocked (.+?)(?:;|\.)/);
        if (job) {
          owners.delete(job[2]);
          const handed = event.detail.match(/ownership handed to (.+?)\.$/);
          if (handed) owners.set(job[2], handed[1]);
        }
      }
      if (event.kind === 'Mutex block') {
        const match = event.detail.match(/^(.+?#\d+) blocked on/);
        if (match) blocked.add(match[1]);
      }
      if (event.kind === 'Mutex handoff') {
        const match = event.detail.match(/handed off; blocked job is ready/);
        if (match) {
          const waiting = (result.jobs || []).find((job) => job.task_name === event.task && job.release <= event.time && job.completion == null);
          if (waiting) blocked.delete(waiting.job_id);
        }
      }
    });
    return { owners, blocked };
  }

  function updatePlayback(result, tick) {
    if (!result) return;
    const capped = Math.max(0, Math.min(Number(result.duration) - 1, Number(tick) || 0));
    playbackTick = capped;
    $('playbackSlider').value = String(capped);
    $('currentTickLabel').textContent = `Tick ${capped}`;
    window.AutoRTGantt.updateCursor($('ganttContainer'), capped);
    const current = (result.timeline || [])[capped];
    const mutex = buildMutexState(result, capped);
    const completed = new Set((result.jobs || []).filter((job) => job.completion != null && job.completion <= capped).map((job) => job.job_id));
    const readyJobs = (result.jobs || []).filter((job) => job.release <= capped && job.completion == null && !completed.has(job.job_id) && !mutex.blocked.has(job.job_id) && job.job_id !== current?.job_id);
    const names = [...new Set(readyJobs.map((job) => job.task_name))];
    const runningLevel = result.algorithm_key === 'MLFQ' && current?.mlfq_level != null ? ` · L${current.mlfq_level}` : '';
    $('runningTaskValue').textContent = current ? `${current.task}${runningLevel}` : 'CPU idle';
    $('readyQueueValue').textContent = `Ready: ${names.join(', ') || '—'} · Mutex: ${[...mutex.owners.entries()].map(([resource, owner]) => `${resource} → ${owner.split('#')[0]}`).join(', ') || 'free'}`;
    $('currentTickLabel').setAttribute('aria-valuetext', `Tick ${capped}, running ${current?.task || 'idle'}${runningLevel}`);
    renderEvents(result.events || [], capped);
  }

  function eventType(event) {
    if (event.kind.startsWith('Mutex')) return event.kind;
    return event.kind;
  }

  function renderEvents(events, upToTick = Infinity) {
    const kinds = new Set(events.map(eventType));
    const filters = EVENT_FILTERS.filter(([label, kind]) => kind == null || kinds.has(kind));
    $('eventFilters').innerHTML = filters.map(([label, kind]) => `<button type="button" class="filter-chip ${(selectedEventKind === kind || (selectedEventKind == null && kind == null)) ? 'is-active' : ''}" data-filter="${escapeHtml(kind || '')}">${escapeHtml(label)}</button>`).join('');
    $('eventFilters').querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
      selectedEventKind = button.dataset.filter || null;
      renderEvents(events, upToTick);
    }));
    const visible = events.filter((event) => event.time <= upToTick && (!selectedEventKind || event.kind === selectedEventKind));
    $('eventCount').textContent = `${visible.length}/${events.length}`;
    const log = $('eventLog');
    const shouldScroll = Number.isFinite(upToTick) || log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = visible.length ? visible.map((event, index) => `
      <div class="event-row" data-kind="${escapeHtml(event.kind)}">
        <span class="event-time">t=${Number(event.time)}</span><span class="event-icon" aria-hidden="true">${EVENT_ICONS[event.kind] || '·'}</span>
        <span class="event-copy"><strong><i class="event-task-dot" style="background:${event.task ? taskColor(event.task, index) : 'transparent'}"></i>${escapeHtml(event.kind)} · ${escapeHtml(event.task || 'System')}</strong><small>${escapeHtml(event.detail || '')}</small></span>
      </div>`).join('') : '<div class="empty-state small-empty">No matching events</div>';
    if (shouldScroll) log.scrollTop = log.scrollHeight;
  }

  function togglePlayback() {
    if (!lastResult) return;
    if (playbackTimer) {
      window.clearInterval(playbackTimer);
      playbackTimer = null;
      $('playButton').textContent = '▶';
      $('playButton').setAttribute('aria-label', 'Play schedule');
      return;
    }
    const delay = Number($('playbackSpeed').value) || 500;
    $('playButton').textContent = 'Ⅱ';
    $('playButton').setAttribute('aria-label', 'Pause schedule');
    playbackTimer = window.setInterval(() => {
      const next = playbackTick >= lastResult.duration - 1 ? 0 : playbackTick + 1;
      updatePlayback(lastResult, next);
    }, delay);
  }

  async function runComparison() {
    const { tasks: selectedTasks, errors } = validateTaskRows();
    if (errors.length) return;
    const selected = [...$('algorithmChecks').querySelectorAll('input:checked')].map((input) => input.value);
    if (!selected.length) {
      showNotice('compareError', 'Select at least one algorithm.');
      return;
    }
    const button = $('compareButton');
    setLoading(button, true, 'Run comparison');
    try {
      comparePayload = await requestJson('/api/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...simulationRequest(selectedTasks), algorithms: selected }),
      });
      compareRows = comparePayload.summary.slice();
      renderComparison();
      $('compareError').classList.add('hidden');
      notify(`Compared ${compareRows.length} scheduling policies.`);
    } catch (error) {
      showNotice('compareError', error.message);
      notify(error.message, true);
    } finally {
      setLoading(button, false, 'Run comparison');
    }
  }

  function renderComparison() {
    if (!comparePayload) return;
    const direction = compareSort.direction === 'asc' ? 1 : -1;
    const sorted = compareRows.slice().sort((first, second) => {
      const left = first[compareSort.key];
      const right = second[compareSort.key];
      if (left == null) return 1;
      if (right == null) return -1;
      return (typeof left === 'string' ? left.localeCompare(right) : Number(left) - Number(right)) * direction;
    });
    const body = $('compareTable').querySelector('tbody');
    body.innerHTML = sorted.map((row) => {
      const color = GROUP_COLORS[row.group] || '#22d3ee';
      return `<tr class="${row.is_best ? 'is-best' : ''} ${Number(row.deadline_misses) > 0 ? 'has-misses' : ''}">
        <td><span class="policy-label"><i class="policy-swatch" style="background:${color}"></i>${escapeHtml(row.algorithm)}</span>${row.is_best ? '<span class="best-badge">Best</span>' : ''}</td>
        <td>${Number(row.deadline_misses)}</td><td>${(Number(row.deadline_miss_ratio) * 100).toFixed(1)}%</td>
        <td>${Number(row.cpu_utilization).toFixed(1)}%</td><td>${Number(row.context_switches)}</td>
        <td>${row.average_response_time == null ? '—' : `${Number(row.average_response_time).toFixed(1)} ticks`}</td><td>${escapeHtml(row.schedulable)}</td>
      </tr>`;
    }).join('');
    $('compareResults').classList.remove('hidden');
    $('compareChart').replaceChildren(window.AutoRTCharts.buildMissChart(compareRows, algorithms));
    $('compareTimelines').innerHTML = comparePayload.results.map((result) => `
      <details><summary><span>${escapeHtml(result.algorithm)}</span><small>${Number(result.metrics.total_deadline_misses)} deadline misses · ${Number(result.metrics.cpu_utilization).toFixed(1)}% CPU</small></summary><div class="gantt-viewport"></div></details>`).join('');
    [...$('compareTimelines').querySelectorAll('details')].forEach((details, index) => {
      details.addEventListener('toggle', () => {
        if (details.open && !details.dataset.drawn) {
          const viewport = details.querySelector('.gantt-viewport');
          drawGantt(comparePayload.results[index], viewport, { cursor: 0 });
          details.dataset.drawn = 'true';
        }
      });
    });
  }

  async function runDemo() {
    const button = $('demoButton');
    setLoading(button, true, 'Run demo');
    try {
      demoPayload = await requestJson('/api/priority-inversion-demo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: $('demoAlgorithm').value }),
      });
      renderDemo(demoPayload);
      $('demoError').classList.add('hidden');
      notify('Priority inversion demonstration ready.');
    } catch (error) {
      showNotice('demoError', error.message);
      notify(error.message, true);
    } finally {
      setLoading(button, false, 'Run demo');
    }
  }

  function findInversionRange(result) {
    const events = result.events || [];
    const block = events.find((event) => event.kind === 'Mutex block' && event.task === 'Emergency Braking');
    if (!block) return null;
    const unlock = events.find((event) => event.kind === 'Mutex unlock' && event.task === 'Infotainment' && event.time >= block.time);
    if (!unlock) return null;
    return { start: Number(block.time), end: Number(unlock.time) };
  }

  function renderDemo(payload) {
    const without = payload.without_inheritance;
    const withInheritance = payload.with_inheritance;
    const range = findInversionRange(without);
    $('demoResultLine').textContent = payload.result_line;
    $('demoResultLine').classList.toggle('is-met', payload.result_line.endsWith('MET'));
    drawGantt(without, $('demoWithoutChart'), { inversionRange: range });
    drawGantt(withInheritance, $('demoWithChart'));
    const maximum = Math.max(1, Number(without.duration) - 1);
    $('demoPlaybackSlider').max = String(maximum);
    $('demoPlaybackSlider').value = '0';
    $('demoResults').classList.remove('hidden');
    const interval = $('inversionInterval');
    if (range) {
      interval.textContent = `Measured inversion interval: tick ${range.start} to ${range.end}, derived from Emergency Braking's mutex block and Infotainment's unlock events.`;
      interval.classList.remove('hidden');
    } else interval.classList.add('hidden');
    demoTick = 0;
    updateDemoPlayback(0);
  }

  function updateDemoPlayback(tick) {
    if (!demoPayload) return;
    demoTick = Math.max(0, Math.min(Number(demoPayload.without_inheritance.duration) - 1, Number(tick) || 0));
    $('demoPlaybackSlider').value = String(demoTick);
    $('demoTickLabel').textContent = `Tick ${demoTick}`;
    window.AutoRTGantt.updateCursor($('demoWithoutChart'), demoTick);
    window.AutoRTGantt.updateCursor($('demoWithChart'), demoTick);
    const range = findInversionRange(demoPayload.without_inheritance);
    const tasks = demoPayload.tasks || [];
    const lockAt = demoPayload.without_inheritance.events.find((event) => event.kind === 'Mutex lock' && event.task === 'Infotainment')?.time ?? 0;
    const currentStep = range && demoTick >= range.end ? 3 : range && demoTick > range.start ? 2 : range && demoTick >= range.start ? 1 : 0;
    $('explanationSteps').querySelectorAll('[data-step]').forEach((step, index) => step.classList.toggle('is-current', index === currentStep));
    const labels = ['Infotainment acquires SensorBus', 'Emergency Braking blocks on SensorBus', 'Lane Detection delays the low-priority owner', 'Inheritance lets the owner release the mutex sooner'];
    $('demoTickLabel').setAttribute('aria-valuetext', `Tick ${demoTick}. ${labels[currentStep]}. ${tasks.length} demo tasks.`);
  }

  function toggleDemoPlayback() {
    if (!demoPayload) return;
    if (demoTimer) {
      window.clearInterval(demoTimer);
      demoTimer = null;
      $('demoPlayButton').textContent = '▶';
      $('demoPlayButton').setAttribute('aria-label', 'Play synchronized demo');
      return;
    }
    $('demoPlayButton').textContent = 'Ⅱ';
    $('demoPlayButton').setAttribute('aria-label', 'Pause synchronized demo');
    demoTimer = window.setInterval(() => updateDemoPlayback(demoTick >= demoPayload.without_inheritance.duration - 1 ? 0 : demoTick + 1), 500);
  }

  function setActiveTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab').forEach((button) => {
      const selected = button.dataset.tab === tab;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      const selected = panel.id === `panel-${tab}`;
      panel.classList.toggle('hidden', !selected);
      panel.classList.toggle('is-active', selected);
    });
    moveTabUnderline();
  }

  function moveTabUnderline() {
    const active = document.querySelector('.tab.is-active');
    const nav = document.querySelector('.tabs');
    const underline = document.querySelector('.tab-underline');
    if (!active || !nav || !underline) return;
    underline.style.width = `${active.offsetWidth}px`;
    underline.style.transform = `translateX(${active.offsetLeft - nav.scrollLeft}px)`;
  }

  function togglePresentation(force) {
    const enabled = force == null ? !document.body.classList.contains('presentation-mode') : Boolean(force);
    document.body.classList.toggle('presentation-mode', enabled);
    $('presentationButton').setAttribute('aria-pressed', String(enabled));
    $('presentationButton').textContent = enabled ? 'Exit presentation' : 'Presentation mode';
    saveSettings();
  }

  function downloadJson() {
    if (!lastResult) return notify('Run a simulation before exporting JSON.', true);
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `autort-sim-${lastResult.algorithm_key}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function updateDeleteEnabled() {
    const rows = $('taskTable').querySelectorAll('tbody tr');
    rows.forEach((row) => row.querySelector('.delete-row').disabled = rows.length < 2);
  }

  async function initialize() {
    try {
      const [catalog, defaultPayload] = await Promise.all([
        requestJson('/api/algorithms'), requestJson('/api/default-tasks'),
      ]);
      algorithms = catalog.algorithms;
      groups = catalog.groups;
      renderAlgorithmSelect();
      renderAlgorithmChecks();
      renderAboutGroups();
      renderTaskTable(defaultPayload.tasks);
      $('simLengthInput').value = '100';
      updateDeleteEnabled();
      $('loadingSkeleton').classList.add('hidden');
    } catch (error) {
      $('loadingSkeleton').classList.add('hidden');
      showNotice('simulateError', error.message);
      $('connectionState').className = 'connection-state is-offline';
      $('connectionState').lastElementChild.textContent = 'Backend offline';
    }
  }

  document.querySelectorAll('.tab').forEach((button, index, all) => {
    button.addEventListener('click', () => setActiveTab(button.dataset.tab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
      all[next].focus();
      setActiveTab(all[next].dataset.tab);
    });
  });
  $('algorithmSelect').addEventListener('change', updateAlgorithmControls);
  $('inheritanceToggle').addEventListener('change', saveSettings);
  $('presentationButton').addEventListener('click', () => togglePresentation());
  $('runButton').addEventListener('click', runSimulation);
  $('compareButton').addEventListener('click', runComparison);
  $('demoButton').addEventListener('click', runDemo);
  $('demoShortcut').addEventListener('click', async () => {
    try {
      const payload = await requestJson('/api/default-tasks');
      renderTaskTable(payload.tasks);
      $('algorithmSelect').value = 'PRIORITY_P';
      $('demoAlgorithm').value = 'PRIORITY_P';
      updateAlgorithmControls();
      setActiveTab('demo');
      await runDemo();
    } catch (error) {
      showNotice('demoError', error.message);
      notify(error.message, true);
    }
  });
  $('resetTasksButton').addEventListener('click', async () => {
    try {
      renderTaskTable((await requestJson('/api/default-tasks')).tasks);
      $('taskValidation').classList.add('hidden');
      notify('Default vehicle workload restored.');
    } catch (error) { notify(error.message, true); }
  });
  $('addRowButton').addEventListener('click', () => {
    renderTaskTable([...readTaskRows(), defaultTask()]);
    $('taskTable').querySelector('tbody tr:last-child [data-field="name"]').focus();
    updateDeleteEnabled();
  });
  $('taskTable').addEventListener('input', (event) => {
    event.target.classList.remove('invalid');
    if (event.target.dataset.field === 'name') {
      const row = event.target.closest('tr');
      const index = Number(row.dataset.row);
      const color = taskColor(event.target.value, index);
      const dot = row.querySelector('.task-dot');
      dot.style.background = color;
      dot.style.color = color;
    }
    updateTaskWarnings();
  });
  $('taskTable').addEventListener('change', updateTaskWarnings);
  $('advancedFields').addEventListener('toggle', (event) => $('taskTable').closest('.task-editor').classList.toggle('is-advanced', event.target.open));
  $('selectAllAlgorithms').addEventListener('click', () => $('algorithmChecks').querySelectorAll('input').forEach((input) => input.checked = true));
  $('selectRealtimeAlgorithms').addEventListener('click', () => $('algorithmChecks').querySelectorAll('input').forEach((input) => input.checked = getAlgorithm(input.value)?.group === 'Real-time'));
  $('clearAlgorithms').addEventListener('click', () => $('algorithmChecks').querySelectorAll('input').forEach((input) => input.checked = false));
  $('zoomSlider').addEventListener('input', () => {
    if (lastResult) drawGantt(lastResult, $('ganttContainer'), { cursor: playbackTick });
  });
  $('playButton').addEventListener('click', togglePlayback);
  $('stepButton').addEventListener('click', () => lastResult && updatePlayback(lastResult, Math.min(lastResult.duration - 1, playbackTick + 1)));
  $('restartButton').addEventListener('click', () => {
    if (playbackTimer) togglePlayback();
    lastResult && updatePlayback(lastResult, 0);
  });
  $('playbackSlider').addEventListener('input', (event) => updatePlayback(lastResult, Number(event.target.value)));
  $('playbackSpeed').addEventListener('change', () => {
    if (playbackTimer) { togglePlayback(); togglePlayback(); }
  });
  $('exportJsonButton').addEventListener('click', downloadJson);
  $('exportPngButton').addEventListener('click', () => {
    window.AutoRTGantt.downloadPng($('ganttContainer').querySelector('.gantt-svg')).catch((error) => notify(error.message, true));
  });
  $('demoPlayButton').addEventListener('click', toggleDemoPlayback);
  $('demoStepButton').addEventListener('click', () => updateDemoPlayback(demoTick + 1));
  $('demoPlaybackSlider').addEventListener('input', (event) => updateDemoPlayback(Number(event.target.value)));
  $('compareTable').querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    compareSort = { key, direction: compareSort.key === key && compareSort.direction === 'asc' ? 'desc' : 'asc' };
    renderComparison();
  }));
  window.addEventListener('resize', moveTabUnderline);
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const isTyping = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName));
    if (isTyping || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); runSimulation(); }
    if (event.code === 'Space') {
      event.preventDefault();
      if (activeTab === 'demo') toggleDemoPlayback(); else togglePlayback();
    }
    if (['1', '2', '3', '4'].includes(event.key)) {
      const tabs = ['simulate', 'compare', 'demo', 'about'];
      setActiveTab(tabs[Number(event.key) - 1]);
    }
  });

  initialize();
  window.requestAnimationFrame(moveTabUnderline);
})();/*
const DEFAULT_TASKS = [
  { name: 'Emergency Braking', period: 20, execution_time: 3, relative_deadline: 20, priority: 1, criticality: 'Safety-Critical', shared_resource: 'SensorBus', resource_hold_time: 1, release_offset: 0 },
  { name: 'Obstacle Avoidance', period: 40, execution_time: 8, relative_deadline: 40, priority: 2, criticality: 'Safety-Critical', shared_resource: '', resource_hold_time: 0, release_offset: 0 },
  { name: 'Lane Detection', period: 50, execution_time: 10, relative_deadline: 50, priority: 3, criticality: 'Safety-Critical', shared_resource: '', resource_hold_time: 0, release_offset: 0 },
  { name: 'Sensor Fusion', period: 100, execution_time: 15, relative_deadline: 100, priority: 4, criticality: 'Safety-Critical', shared_resource: '', resource_hold_time: 0, release_offset: 0 },
  { name: 'Infotainment', period: 200, execution_time: 30, relative_deadline: 200, priority: 5, criticality: 'Non-Critical', shared_resource: 'SensorBus', resource_hold_time: 10, release_offset: 0 },
];

const tabButtons = [...document.querySelectorAll('.tab')];
const panels = {
  simulate: document.getElementById('simulate-panel'),
  compare: document.getElementById('compare-panel'),
  demo: document.getElementById('demo-panel'),
};
const tooltip = document.getElementById('tooltip');
const simulateError = document.getElementById('simulateError');
const compareError = document.getElementById('compareError');
const demoError = document.getElementById('demoError');

let currentTasks = DEFAULT_TASKS.map(task => ({ ...task }));
let loadingState = { simulate: false, compare: false, demo: false };

function showError(element, message) {
  if (!message) {
    element.classList.add('hidden');
    element.textContent = '';
    return;
  }
  element.textContent = message;
  element.classList.remove('hidden');
}

function setLoading(button, isLoading, label) {
  button.disabled = isLoading;
  button.textContent = isLoading ? label : label;
}

function setActiveTab(tabName) {
  tabButtons.forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });

  Object.entries(panels).forEach(([key, panel]) => {
    panel.classList.toggle('hidden', key !== tabName);
    panel.classList.toggle('is-visible', key === tabName);
  });
}

tabButtons.forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

function buildTaskRow(task = { name: '', period: 10, execution_time: 1, relative_deadline: 10, priority: 1, criticality: 'Safety-Critical', shared_resource: '', resource_hold_time: 0, release_offset: 0 }) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input data-field="name" value="${escapeHtml(task.name || '')}" /></td>
    <td><input data-field="period" type="number" min="1" value="${Number(task.period || 1)}" /></td>
    <td><input data-field="execution_time" type="number" min="1" value="${Number(task.execution_time || 1)}" /></td>
    <td><input data-field="relative_deadline" type="number" min="1" value="${Number(task.relative_deadline || task.period || 1)}" /></td>
    <td><input data-field="priority" type="number" min="1" value="${Number(task.priority || 1)}" /></td>
    <td>
      <select data-field="criticality">
        <option value="Safety-Critical" ${task.criticality === 'Safety-Critical' ? 'selected' : ''}>Safety-Critical</option>
        <option value="Non-Critical" ${task.criticality === 'Non-Critical' ? 'selected' : ''}>Non-Critical</option>
      </select>
    </td>
    <td><input data-field="shared_resource" value="${escapeHtml(task.shared_resource || '')}" /></td>
    <td><input data-field="resource_hold_time" type="number" min="0" value="${Number(task.resource_hold_time || 0)}" /></td>
    <td><input data-field="release_offset" type="number" min="0" value="${Number(task.release_offset || 0)}" /></td>
    <td><button class="delete-btn" type="button">Delete</button></td>
  `;

  row.querySelector('.delete-btn').addEventListener('click', () => {
    const rows = document.querySelectorAll('#taskTable tbody tr');
    if (rows.length > 1) {
      row.remove();
    }
  });

  return row;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderTaskTable(tasks) {
  const tbody = document.querySelector('#taskTable tbody');
  tbody.innerHTML = '';
  tasks.forEach((task) => {
    tbody.appendChild(buildTaskRow(task));
  });
}

function readTasksFromTable() {
  const rows = [...document.querySelectorAll('#taskTable tbody tr')];
  const tasks = rows.map((row) => {
    const fields = row.querySelectorAll('[data-field]');
    const result = {};
    fields.forEach((input) => {
      const field = input.dataset.field;
      if (field === 'criticality') {
        result[field] = input.value;
      } else if (field === 'name' || field === 'shared_resource') {
        result[field] = input.value;
      } else {
        result[field] = Number(input.value || 0);
      }
    });

    return {
      name: String(result.name || '').trim(),
      period: Number(result.period || 1),
      execution_time: Number(result.execution_time || 1),
      relative_deadline: Number(result.relative_deadline || result.period || 1),
      priority: Number(result.priority || 1),
      criticality: result.criticality || 'Safety-Critical',
      shared_resource: String(result.shared_resource || '').trim() || null,
      resource_hold_time: Number(result.resource_hold_time || 0),
      release_offset: Number(result.release_offset || 0),
    };
  }).filter((task) => task.name.length > 0);

  return tasks;
}

async function loadDefaultTasks() {
  const response = await fetch('/api/default-tasks');
  const payload = await response.json();
  if (!payload.tasks) {
    throw new Error('Default tasks response was invalid.');
  }
  currentTasks = payload.tasks;
  renderTaskTable(currentTasks);
  document.getElementById('simLengthInput').value = '100';
}

document.getElementById('addRowButton').addEventListener('click', () => {
  const tbody = document.querySelector('#taskTable tbody');
  tbody.appendChild(buildTaskRow());
});

document.getElementById('resetTasksButton').addEventListener('click', () => {
  currentTasks = DEFAULT_TASKS.map((task) => ({ ...task }));
  renderTaskTable(currentTasks);
  showError(simulateError, '');
});

document.getElementById('algorithmSelect').addEventListener('change', (event) => {
  const isRR = event.target.value === 'RR';
  document.getElementById('quantumWrap').style.display = isRR ? 'flex' : 'none';
});

function getUtilizationWarning(tasks) {
  if (!tasks || tasks.length === 0) return '';
  const totalUtilization = tasks.reduce((sum, task) => sum + (task.execution_time / task.period), 0);
  if (totalUtilization > 1) {
    return `Utilization is ${totalUtilization.toFixed(2)} (> 100%), so the set is overloaded.`;
  }
  return '';
}

async function runSimulation() {
  const button = document.getElementById('runButton');
  const tasks = readTasksFromTable();
  const warning = getUtilizationWarning(tasks);
  const warningBox = document.getElementById('utilizationWarning');
  warningBox.textContent = warning;
  warningBox.classList.toggle('hidden', !warning);

  const requestBody = {
    tasks,
    algorithm: document.getElementById('algorithmSelect').value,
    quantum: Number(document.getElementById('quantumInput').value || 2),
    sim_length: Number(document.getElementById('simLengthInput').value || 100),
    priority_inheritance: document.getElementById('inheritanceToggle').checked,
  };

  button.disabled = true;
  button.textContent = 'Running...';
  showError(simulateError, '');

  try {
    const response = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || 'Simulation failed.');
    }

    renderSimulationResult(payload);
    setActiveTab('simulate');
  } catch (error) {
    showError(simulateError, error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Run';
  }
}

function renderSimulationResult(result) {
  const metrics = result.metrics || {};
  document.getElementById('missesStat').textContent = metrics.total_deadline_misses ?? 0;
  document.getElementById('utilizationStat').textContent = `${Number(metrics.cpu_utilization ?? 0).toFixed(1)}%`;
  document.getElementById('switchesStat').textContent = metrics.context_switches ?? 0;
  document.getElementById('schedulableStat').textContent = metrics.schedulability ?? 'Unknown';

  const taskMetricsBody = document.getElementById('taskMetricsBody');
  taskMetricsBody.innerHTML = '';
  Object.entries(metrics.per_task || {}).forEach(([taskName, taskMetrics]) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(taskName)}</td>
      <td>${taskMetrics.deadline_misses ?? 0}</td>
      <td>${taskMetrics.average_response_time == null ? '—' : `${taskMetrics.average_response_time.toFixed(1)} ticks`}</td>
      <td>${taskMetrics.worst_case_response_time == null ? '—' : `${taskMetrics.worst_case_response_time} ticks`}</td>
    `;
    taskMetricsBody.appendChild(row);
  });

  const eventList = document.getElementById('eventLog');
  const events = result.events || [];
  eventList.innerHTML = events.length
    ? events.map((event) => `
        <div class="event-item">
          <strong>${event.time}</strong> · ${escapeHtml(event.kind)} · ${escapeHtml(event.task || 'System')}<br />
          ${escapeHtml(event.detail || '')}
        </div>
      `).join('')
    : '<div class="event-item">No events recorded.</div>';

  document.getElementById('ganttContainer').innerHTML = '';
  document.getElementById('ganttContainer').appendChild(buildGanttSvg(result));

  document.getElementById('simulateResults').classList.remove('hidden');
}

async function compareAlgorithms() {
  const button = document.getElementById('compareButton');
  const tasks = readTasksFromTable();
  const body = {
    tasks,
    algorithm: document.getElementById('algorithmSelect').value,
    quantum: Number(document.getElementById('quantumInput').value || 2),
    sim_length: Number(document.getElementById('simLengthInput').value || 100),
    priority_inheritance: document.getElementById('inheritanceToggle').checked,
  };

  button.disabled = true;
  button.textContent = 'Running...';
  showError(compareError, '');

  try {
    const response = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || 'Comparison failed.');
    }
    renderComparison(payload);
    setActiveTab('compare');
  } catch (error) {
    showError(compareError, error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Compare';
  }
}

function renderComparison(payload) {
  const summary = payload.summary || [];
  const tbody = document.querySelector('#compareTable tbody');
  tbody.innerHTML = '';

  let bestIndex = 0;
  summary.forEach((row, index) => {
    if ((row.deadline_misses ?? 0) < (summary[bestIndex].deadline_misses ?? 0)) {
      bestIndex = index;
    }
  });

  summary.forEach((row, index) => {
    const tr = document.createElement('tr');
    if (index === bestIndex) {
      tr.classList.add('best-row');
    }
    tr.innerHTML = `
      <td>${escapeHtml(row.algorithm)}</td>
      <td>${row.deadline_misses}</td>
      <td>${Number(row.cpu_utilization).toFixed(1)}%</td>
      <td>${row.context_switches}</td>
      <td>${row.schedulable}</td>
    `;
    tbody.appendChild(tr);
  });

  const chart = document.getElementById('compareChart');
  chart.innerHTML = '';
  const max = Math.max(1, ...summary.map((row) => Number(row.deadline_misses || 0)));

  summary.forEach((row) => {
    const group = document.createElement('div');
    group.className = 'bar-group';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${((Number(row.deadline_misses || 0) / max) * 100)}%`;
    bar.title = `${row.algorithm}: ${row.deadline_misses} misses`;
    const label = document.createElement('strong');
    label.textContent = row.algorithm;
    group.appendChild(bar);
    group.appendChild(label);
    chart.appendChild(group);
  });

  document.getElementById('compareResults').classList.remove('hidden');
}

async function runDemo() {
  const button = document.getElementById('demoButton');
  button.disabled = true;
  button.textContent = 'Running...';
  showError(demoError, '');

  try {
    const response = await fetch('/api/priority-inversion-demo', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || 'Priority inversion demo failed.');
    }
    renderDemo(payload);
    setActiveTab('demo');
  } catch (error) {
    showError(demoError, error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Run Demo';
  }
}

function renderDemo(payload) {
  const resultLine = document.getElementById('demoResultLine');
  resultLine.textContent = payload.result_line || 'Emergency Braking: MISSED -> MET';

  const explanation = document.getElementById('demoExplanation');
  explanation.textContent = payload.explanation || '';

  const withoutChart = document.getElementById('demoWithoutChart');
  withoutChart.innerHTML = '';
  withoutChart.appendChild(buildGanttSvg(payload.without_inheritance, 'Without Priority Inheritance'));

  const withChart = document.getElementById('demoWithChart');
  withChart.innerHTML = '';
  withChart.appendChild(buildGanttSvg(payload.with_inheritance, 'With Priority Inheritance'));

  document.getElementById('demoResults').classList.remove('hidden');
}

function buildGanttSvg(result, title = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const duration = Number(result.duration || 1);
  const tasks = result.tasks || [];
  const taskNames = tasks.map((task) => task.name);
  const colorMap = ['#7c8cff', '#8bc7a1', '#ffb36d', '#d7b5ff', '#ff9bae', '#7fd0d8', '#c7d3f7'];
  const rowHeight = 36;
  const labelWidth = 160;
  const chartHeight = Math.max(120, tasks.length * rowHeight + 42);
  const chartWidth = Math.max(780, duration * 18 + labelWidth + 40);
  svg.setAttribute('viewBox', `0 0 ${chartWidth} ${chartHeight}`);
  svg.setAttribute('role', 'img');

  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  axis.setAttribute('class', 'gantt-axis');

  for (let i = 0; i <= duration; i += Math.max(1, Math.round(duration / 10))) {
    const x = labelWidth + (i / duration) * (chartWidth - labelWidth - 30);
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('x2', x);
    tick.setAttribute('y1', 18);
    tick.setAttribute('y2', chartHeight - 12);
    tick.setAttribute('stroke', '#e2e7f0');
    tick.setAttribute('stroke-width', '1');
    axis.appendChild(tick);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', chartHeight - 6);
    text.setAttribute('text-anchor', 'middle');
    text.textContent = String(i);
    axis.appendChild(text);
  }
  svg.appendChild(axis);

  const rows = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  tasks.forEach((task, index) => {
    const y = 24 + index * rowHeight;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', 12);
    label.setAttribute('y', y + 12);
    label.setAttribute('class', 'gantt-row-label');
    label.textContent = task.name;
    rows.appendChild(label);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', labelWidth);
    line.setAttribute('x2', chartWidth - 10);
    line.setAttribute('y1', y + 18);
    line.setAttribute('y2', y + 18);
    line.setAttribute('stroke', '#e5e7ef');
    line.setAttribute('stroke-width', '1');
    rows.appendChild(line);
  });
  svg.appendChild(rows);

  const jobs = result.jobs || [];
  const jobMap = new Map();
  jobs.forEach((job) => {
    const key = job.task_name;
    if (!jobMap.has(key)) jobMap.set(key, []);
    jobMap.get(key).push(job);
  });

  const timeline = result.timeline || [];
  const segmentsByTask = new Map();
  taskNames.forEach((name) => segmentsByTask.set(name, []));
  timeline.forEach((tick, idx) => {
    if (!tick.task) return;
    const current = segmentsByTask.get(tick.task);
    if (!current.length || current[current.length - 1].end !== tick.time) {
      current.push({ task: tick.task, start: tick.time, end: tick.time + 1 });
    } else {
      current[current.length - 1].end += 1;
    }
  });

  taskNames.forEach((name, index) => {
    const bars = segmentsByTask.get(name) || [];
    const color = colorMap[index % colorMap.length];
    bars.forEach((segment) => {
      const x = labelWidth + (segment.start / duration) * (chartWidth - labelWidth - 30);
      const width = Math.max(8, ((segment.end - segment.start) / duration) * (chartWidth - labelWidth - 30));
      const y = 24 + index * rowHeight + 4;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'gantt-bar');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', width);
      rect.setAttribute('height', 18);
      rect.setAttribute('fill', color);
      rect.setAttribute('opacity', '0.88');
      rect.setAttribute('data-task', name);
      rect.setAttribute('data-start', segment.start);
      rect.setAttribute('data-end', segment.end);
      rect.addEventListener('mousemove', (event) => {
        tooltip.innerHTML = `<strong>${name}</strong><br>Start: ${segment.start}<br>End: ${segment.end}`;
        tooltip.classList.remove('hidden');
        tooltip.style.left = `${event.clientX + 12}px`;
        tooltip.style.top = `${event.clientY + 12}px`;
      });
      rect.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
      svg.appendChild(rect);
    });

    (jobMap.get(name) || []).forEach((job) => {
      if (!job.missed) return;
      const x = labelWidth + (Number(job.deadline) / duration) * (chartWidth - labelWidth - 30);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'gantt-deadline');
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      line.setAttribute('y1', 24 + index * rowHeight + 1);
      line.setAttribute('y2', 24 + index * rowHeight + 30);
      svg.appendChild(line);
    });
  });

  if (title) {
    const titleText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    titleText.setAttribute('x', labelWidth);
    titleText.setAttribute('y', 14);
    titleText.setAttribute('font-size', '12');
    titleText.setAttribute('fill', '#58657c');
    titleText.setAttribute('font-weight', '600');
    titleText.textContent = title;
    svg.insertBefore(titleText, svg.firstChild);
  }

  return svg;
}

document.getElementById('runButton').addEventListener('click', runSimulation);
document.getElementById('compareButton').addEventListener('click', compareAlgorithms);
document.getElementById('demoButton').addEventListener('click', runDemo);

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadDefaultTasks();
    renderTaskTable(currentTasks);
    setActiveTab('simulate');
    document.getElementById('quantumWrap').style.display = 'flex';
  } catch (error) {
    showError(simulateError, error.message);
  }
});
*/
