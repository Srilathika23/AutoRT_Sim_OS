(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COLORS = {
    'Emergency Braking': '#f472b6',
    'Obstacle Avoidance': '#fbbf24',
    'Lane Detection': '#22d3ee',
    'Sensor Fusion': '#a78bfa',
    'Infotainment': '#34d399',
  };
  const EXTRA_COLORS = ['#fb7185', '#60a5fa', '#c084fc', '#f97316', '#2dd4bf', '#e879f9', '#a3e635'];

  function node(name, attributes = {}, text = '') {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
    if (text !== '') element.textContent = String(text);
    return element;
  }

  function colorMapFor(tasks) {
    const map = new Map();
    let extra = 0;
    tasks.forEach((task) => {
      map.set(task.name, COLORS[task.name] || EXTRA_COLORS[extra++ % EXTRA_COLORS.length]);
    });
    return map;
  }

  function shadeForLevel(color, level) {
    const amount = [0, 0.3, 0.58][Math.max(0, Math.min(2, Number(level) || 0))];
    const base = [11, 16, 32];
    const channels = color.match(/[\da-f]{2}/gi).map((channel) => parseInt(channel, 16));
    const shaded = channels.map((channel, index) => Math.round(channel * (1 - amount) + base[index] * amount));
    return `#${shaded.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  function getSegments(timeline, useLevels) {
    const segments = [];
    timeline.forEach((tick) => {
      if (!tick.task) return;
      const last = segments[segments.length - 1];
      const level = useLevels ? tick.mlfq_level : undefined;
      if (last && last.task === tick.task && last.jobId === tick.job_id && last.end === tick.time && (!useLevels || last.level === level)) {
        last.end += 1;
      } else {
        segments.push({ task: tick.task, jobId: tick.job_id, start: tick.time, end: tick.time + 1, level });
      }
    });
    return segments;
  }

  function buildGantt(result, options = {}) {
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    const duration = Math.max(1, Number(result.duration) || 1);
    const scale = Math.max(4, Number(options.scale) || 18);
    const labelWidth = Math.max(132, Number(options.labelWidth) || 164);
    const rightPad = 24;
    const top = 28;
    const rowHeight = 34;
    const chartWidth = labelWidth + duration * scale + rightPad;
    const chartHeight = top + Math.max(1, tasks.length) * rowHeight + 24;
    const rows = new Map(tasks.map((task, index) => [task.name, index]));
    const colors = colorMapFor(tasks);
    const useLevels = result.algorithm_key === 'MLFQ';
    const svg = node('svg', {
      class: 'gantt-svg',
      xmlns: SVG_NS,
      viewBox: `0 0 ${chartWidth} ${chartHeight}`,
      width: chartWidth,
      height: chartHeight,
      role: 'img',
      'aria-label': `${result.algorithm || 'Schedule'} timeline, ${duration} ticks`,
      'data-label-width': labelWidth,
      'data-scale': scale,
      'data-duration': duration,
    });
    const defs = node('defs');
    const hatch = node('pattern', { id: 'idle-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.appendChild(node('rect', { width: 8, height: 8, fill: '#111a2d' }));
    hatch.appendChild(node('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#202b43', 'stroke-width': 2 }));
    defs.appendChild(hatch);
    svg.appendChild(defs);

    const plotWidth = duration * scale;
    const tickStep = Math.max(1, Math.ceil(duration / Math.max(1, Math.floor(plotWidth / 72))));
    for (let tick = 0; tick <= duration; tick += tickStep) {
      const x = labelWidth + tick * scale;
      svg.appendChild(node('line', { x1: x, y1: top - 7, x2: x, y2: chartHeight - 18, stroke: '#27324a', 'stroke-width': 1 }));
      svg.appendChild(node('text', { x, y: chartHeight - 4, fill: '#8993ad', 'font-size': 9, 'text-anchor': 'middle' }, tick));
    }
    if (duration % tickStep !== 0) {
      const x = labelWidth + duration * scale;
      svg.appendChild(node('text', { x, y: chartHeight - 4, fill: '#8993ad', 'font-size': 9, 'text-anchor': 'middle' }, duration));
    }

    tasks.forEach((task, index) => {
      const y = top + index * rowHeight;
      const color = colors.get(task.name);
      svg.appendChild(node('circle', { cx: 8, cy: y + 9, r: 3.5, fill: color }));
      svg.appendChild(node('text', { x: 17, y: y + 12, fill: '#c9d1e7', 'font-size': 10 }, task.name));
      svg.appendChild(node('rect', { x: labelWidth, y: y - 1, width: plotWidth, height: 22, rx: 4, fill: 'url(#idle-hatch)' }));
      svg.appendChild(node('line', { x1: labelWidth, y1: y + 22, x2: labelWidth + plotWidth, y2: y + 22, stroke: '#222c43', 'stroke-width': 1 }));
    });

    const inversion = options.inversionRange;
    if (inversion && Number.isFinite(inversion.start) && Number.isFinite(inversion.end)) {
      const start = Math.max(0, Math.min(duration, inversion.start));
      const end = Math.max(start, Math.min(duration, inversion.end));
      const height = Math.max(1, tasks.length) * rowHeight;
      svg.appendChild(node('rect', {
        x: labelWidth + start * scale,
        y: top - 7,
        width: Math.max(2, (end - start) * scale),
        height,
        fill: '#f87171',
        opacity: 0.12,
        class: 'inversion-shade',
      }));
      svg.appendChild(node('text', {
        x: labelWidth + start * scale + 5,
        y: top - 11,
        fill: '#fca5a5',
        'font-size': 9,
        class: 'inversion-label',
      }, 'Priority inversion: Emergency Braking blocked by Infotainment while Lane Detection runs'));
    }

    const jobMap = new Map((result.jobs || []).map((job) => [job.job_id, job]));
    getSegments(result.timeline || [], useLevels).forEach((segment) => {
      if (!rows.has(segment.task)) return;
      const index = rows.get(segment.task);
      const y = top + index * rowHeight + 2;
      const x = labelWidth + segment.start * scale;
      const width = Math.max(2, (segment.end - segment.start) * scale - 1.5);
      const job = jobMap.get(segment.jobId);
      const levelDetail = useLevels && segment.level != null ? ` · level ${segment.level}` : '';
      const title = `${segment.task} · ${segment.start}–${segment.end}${levelDetail}${job && job.response_time != null ? ` · response ${job.response_time} ticks` : ''}`;
      const barColor = useLevels ? shadeForLevel(colors.get(segment.task), segment.level) : colors.get(segment.task);
      const bar = node('rect', {
        x,
        y,
        width,
        height: 17,
        rx: 5,
        fill: barColor,
        opacity: useLevels ? 1 : 0.9,
        class: 'gantt-bar',
        tabindex: 0,
        role: 'img',
        'aria-label': title,
      });
      bar.appendChild(node('title', {}, title));
      bar.addEventListener('pointermove', (event) => showTooltip(event, title));
      bar.addEventListener('pointerleave', hideTooltip);
      bar.addEventListener('focus', () => showTooltipForElement(bar, title));
      bar.addEventListener('blur', hideTooltip);
      svg.appendChild(bar);
      if (useLevels && segment.level != null && width >= 25) {
        svg.appendChild(node('text', {
          x: x + width / 2,
          y: y + 12,
          fill: segment.level === 2 ? '#e6e9f5' : '#0b1020',
          'font-size': 9,
          'font-weight': 750,
          'text-anchor': 'middle',
          'pointer-events': 'none',
          class: 'mlfq-level-label',
        }, `L${segment.level}`));
      }
    });

    (result.events || []).filter((event) => event.kind === 'Release' && rows.has(event.task)).forEach((event) => {
      const x = labelWidth + Number(event.time) * scale;
      const y = top + rows.get(event.task) * rowHeight - 3;
      svg.appendChild(node('path', { d: `M${x} ${y}l-4 -5h8z`, fill: colors.get(event.task), class: 'release-marker' }));
    });

    (result.jobs || []).filter((job) => rows.has(job.task_name)).forEach((job) => {
      const x = labelWidth + Math.min(duration, Number(job.deadline)) * scale;
      const y = top + rows.get(job.task_name) * rowHeight - 1;
      if (job.missed) {
        const cross = node('g', { class: 'miss-marker', transform: `translate(${x} ${y + 2})` });
        cross.appendChild(node('circle', { r: 7, fill: '#f87171', opacity: 0.14, class: 'miss-glow' }));
        cross.appendChild(node('path', { d: 'M-3 -3 3 3M3 -3-3 3', stroke: '#f87171', 'stroke-width': 2, 'stroke-linecap': 'round' }));
        cross.appendChild(node('title', {}, `${job.task_name} deadline missed at tick ${job.deadline}`));
        svg.appendChild(cross);
      } else {
        svg.appendChild(node('line', { x1: x, y1: y, x2: x, y2: y + 25, stroke: colors.get(job.task_name), 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.5, class: 'deadline-marker' }));
      }
    });

    const cursor = node('line', { x1: labelWidth, x2: labelWidth, y1: top - 7, y2: chartHeight - 17, stroke: '#f8fafc', 'stroke-width': 1.5, class: 'playback-cursor', opacity: 0.86 });
    cursor.appendChild(node('circle', { cx: 0, cy: 0, r: 0 }));
    svg.appendChild(cursor);
    updateCursor(svg, Number(options.cursor) || 0);
    return svg;
  }

  function showTooltip(event, text) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    tooltip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 250)}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - 34)}px`;
  }

  function showTooltipForElement(element, text) {
    const rect = element.getBoundingClientRect();
    showTooltip({ clientX: rect.left, clientY: rect.top }, text);
  }

  function hideTooltip() {
    document.getElementById('tooltip')?.classList.add('hidden');
  }

  function updateCursor(target, tick) {
    const svg = target instanceof SVGElement ? target : target && target.querySelector('.gantt-svg');
    if (!svg) return;
    const labelWidth = Number(svg.dataset.labelWidth) || 164;
    const scale = Number(svg.dataset.scale) || 18;
    const x = labelWidth + Math.max(0, Number(tick) || 0) * scale;
    const cursor = svg.querySelector('.playback-cursor');
    if (cursor) {
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
    }
  }

  async function downloadPng(svg, filename = 'autort-sim-gantt.png') {
    if (!svg) throw new Error('Run a simulation before exporting a Gantt chart.');
    const source = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Could not render the Gantt chart image.'));
      });
      image.src = url;
      await loaded;
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil((Number(svg.getAttribute('width')) || 800) * scale);
      canvas.height = Math.ceil((Number(svg.getAttribute('height')) || 200) * scale);
      const context = canvas.getContext('2d');
      context.fillStyle = '#0d1426';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.scale(scale, scale);
      context.drawImage(image, 0, 0);
      const anchor = document.createElement('a');
      anchor.download = filename;
      anchor.href = canvas.toDataURL('image/png');
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  window.AutoRTGantt = { buildGantt, updateCursor, colorMapFor, shadeForLevel, downloadPng };
})();