(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GROUP_COLORS = {
    Basic: '#22d3ee',
    'Priority-based': '#f472b6',
    'Time-sliced': '#a78bfa',
    'Real-time': '#fbbf24',
  };

  function element(name, attrs = {}, text = '') {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== '') node.textContent = String(text);
    return node;
  }

  function buildMissChart(rows, algorithmMetadata) {
    const values = Array.isArray(rows) ? rows : [];
    const metadata = new Map((algorithmMetadata || []).map((item) => [item.key, item]));
    const labelWidth = 180;
    const plotWidth = 570;
    const chartWidth = labelWidth + plotWidth + 58;
    const rowHeight = 30;
    const top = 16;
    const height = Math.max(112, top + values.length * rowHeight + 18);
    const max = Math.max(1, ...values.map((item) => Number(item.deadline_misses) || 0));
    const svg = element('svg', {
      viewBox: `0 0 ${chartWidth} ${height}`,
      role: 'img',
      'aria-label': 'Deadline misses by scheduling algorithm',
    });
    svg.appendChild(element('title', {}, 'Deadline misses by algorithm'));

    [0, Math.ceil(max / 2), max].filter((value, index, list) => list.indexOf(value) === index).forEach((value) => {
      const x = labelWidth + (value / max) * plotWidth;
      svg.appendChild(element('line', { x1: x, x2: x, y1: 9, y2: height - 12, stroke: '#26314a', 'stroke-width': 1 }));
      svg.appendChild(element('text', { x, y: height - 1, fill: '#8792ac', 'font-size': 9, 'text-anchor': 'middle' }, value));
    });

    values.forEach((row, index) => {
      const y = top + index * rowHeight;
      const meta = metadata.get(row.algorithm_key) || {};
      const color = GROUP_COLORS[row.group || meta.group] || '#22d3ee';
      const count = Number(row.deadline_misses) || 0;
      const width = (count / max) * plotWidth;
      svg.appendChild(element('text', { x: labelWidth - 10, y: y + 12, fill: '#c8d0e4', 'font-size': 10, 'text-anchor': 'end' }, row.algorithm));
      svg.appendChild(element('rect', { x: labelWidth, y, width: Math.max(count ? 2 : 0, width), height: 15, rx: 5, fill: color, opacity: .88, class: 'chart-bar-rect' }));
      svg.appendChild(element('text', { x: labelWidth + width + 8, y: y + 12, fill: '#e6e9f5', 'font-size': 10, 'font-weight': 700 }, count));
    });
    return svg;
  }

  window.AutoRTCharts = { buildMissChart, groupColors: GROUP_COLORS };
})();