const CHART_COLORS = {
  ok: "var(--color-tertiary)",
  warn: "var(--color-warn)",
  critical: "var(--color-critical)",
  muted: "var(--color-border)",
};

let chartIdCounter = 0;
let currentMetric = "cost";
let onNodeSelect = null;

function setChartNodeHandler(handler) {
  onNodeSelect = handler;
}

function assignChartIds(node) {
  node.chartId = `cn-${chartIdCounter++}`;
  for (const child of node.children || []) {
    assignChartIds(child);
  }
}

function resetChartIds() {
  chartIdCounter = 0;
}

function nodeMetric(node, metric) {
  if (metric === "cost") return node.costEnd || 0;
  if (metric === "rows") return node.planRows || 0;
  if (metric === "time") {
    return (node.actualTimeEnd || 0) * (node.loops || 1);
  }
  return 0;
}

function metricLabel(metric) {
  const map = {
    cost: "Cost",
    rows: "Rows",
    time: "Actual time",
  };
  return map[metric] || metric;
}

function collectFlatNodes(tree) {
  const list = [];
  function walk(node) {
    if (node.costEnd != null || node.planRows != null) list.push(node);
    for (const child of node.children || []) walk(child);
  }
  walk(tree);
  return list;
}

function severityColor(severity) {
  return CHART_COLORS[severity] || CHART_COLORS.ok;
}

function truncate(text, max = 28) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function emitSelect(chartId) {
  if (!chartId || !onNodeSelect) return;
  if (Array.isArray(chartId)) {
    onNodeSelect(chartId);
    return;
  }
  onNodeSelect([chartId]);
}

function bindChartItem(el, chartId) {
  if (!chartId || (Array.isArray(chartId) && !chartId.length)) {
    el.classList.add("chart-hit", "chart-hit--static");
    return;
  }

  const ids = Array.isArray(chartId) ? chartId : [chartId];
  el.dataset.chartId = ids[0];
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.classList.add("chart-hit");

  const activate = () => emitSelect(ids.length === 1 ? ids[0] : ids);
  el.addEventListener("click", activate);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
}

function layoutStrip(items, width, height) {
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total <= 0) return [];
  let x = 0;
  return items.map((it) => {
    const w = Math.max(2, (it.value / total) * width);
    const rect = { ...it, x, y: 0, w, h: height };
    x += w;
    return rect;
  });
}

function renderTreemap(svg, nodes, metric) {
  const items = nodes
    .map((node) => ({
      node,
      chartId: node.chartId,
      label: node.nodeType || truncate(node.title, 20),
      value: nodeMetric(node, metric),
      severity: node.severity || "ok",
    }))
    .filter((it) => it.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 14);

  const width = 520;
  const height = 220;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (!items.length) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "28");
    text.setAttribute("class", "chart-empty");
    text.textContent = "Нет данных для метрики";
    svg.appendChild(text);
    return;
  }

  const rects = layoutStrip(items, width, height);
  for (const r of rects) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    bindChartItem(g, r.chartId);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(r.x + 1));
    rect.setAttribute("y", String(r.y + 1));
    rect.setAttribute("width", String(Math.max(0, r.w - 2)));
    rect.setAttribute("height", String(Math.max(0, r.h - 2)));
    rect.setAttribute("rx", "4");
    rect.setAttribute("class", "chart-treemap__rect");
    rect.setAttribute("fill", severityColor(r.severity));

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${r.node.title}\n${metricLabel(metric)}: ${formatCompact(r.value)}`;
    rect.appendChild(title);

    g.appendChild(rect);

    if (r.w > 48 && r.h > 28) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(r.x + 8));
      label.setAttribute("y", String(r.y + 18));
      label.setAttribute("class", "chart-treemap__label");
      label.textContent = truncate(r.label, Math.floor(r.w / 7));
      g.appendChild(label);
    }

    svg.appendChild(g);
  }
}

function renderBarChart(svg, nodes, metric) {
  const items = nodes
    .map((node) => ({
      node,
      chartId: node.chartId,
      label: truncate(node.nodeType || node.title, 32),
      value: nodeMetric(node, metric),
      severity: node.severity || "ok",
    }))
    .filter((it) => it.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const rowH = 26;
  const padL = 150;
  const padR = 56;
  const width = 520;
  const height = Math.max(120, items.length * rowH + 16);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (!items.length) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "28");
    text.setAttribute("class", "chart-empty");
    text.textContent = "Нет данных для метрики";
    svg.appendChild(text);
    return;
  }

  const max = items[0].value || 1;
  const barMaxW = width - padL - padR;

  items.forEach((it, i) => {
    const y = 8 + i * rowH;
    const barW = Math.max(4, (it.value / max) * barMaxW);

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    bindChartItem(g, it.chartId);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "0");
    label.setAttribute("y", String(y + 16));
    label.setAttribute("class", "chart-bar__label");
    label.textContent = it.label;

    const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bar.setAttribute("x", String(padL));
    bar.setAttribute("y", String(y + 4));
    bar.setAttribute("width", String(barW));
    bar.setAttribute("height", "16");
    bar.setAttribute("rx", "3");
    bar.setAttribute("fill", severityColor(it.severity));
    bar.setAttribute("class", "chart-bar__bar");

    const val = document.createElementNS("http://www.w3.org/2000/svg", "text");
    val.setAttribute("x", String(padL + barW + 8));
    val.setAttribute("y", String(y + 16));
    val.setAttribute("class", "chart-bar__value");
    val.textContent = formatCompact(it.value);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = it.node.title;
    bar.appendChild(title);

    g.append(label, bar, val);
    svg.appendChild(g);
  });
}

function measureLeaves(node) {
  if (!node.children?.length) return 1;
  return node.children.reduce((s, c) => s + measureLeaves(c), 0);
}

function layoutFlow(node, depth, left, width, positions, maxNodes) {
  if (positions.length >= maxNodes) return;
  const leaves = Math.max(1, measureLeaves(node));
  const nodeW = 132;
  const nodeH = 44;
  const gapY = 52;
  const x = left + width / 2 - nodeW / 2;
  const y = 16 + depth * gapY;

  positions.push({
    node,
    chartId: node.chartId,
    x,
    y,
    w: nodeW,
    h: nodeH,
    depth,
  });

  if (!node.children?.length || positions.length >= maxNodes) return;

  const childWidth = width / node.children.length;
  node.children.forEach((child, i) => {
    layoutFlow(child, depth + 1, left + i * childWidth, childWidth, positions, maxNodes);
  });
}

function renderFlowChart(svg, tree, metric) {
  const positions = [];
  layoutFlow(tree, 0, 0, Math.max(960, 720), positions, 36);

  const maxY = positions.reduce((m, p) => Math.max(m, p.y + p.h), 0) + 24;
  const width = Math.max(960, 720);
  const height = Math.max(280, maxY);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const byId = new Map(positions.map((p) => [p.chartId, p]));

  for (const pos of positions) {
    const parent = findParent(tree, pos.chartId);
    if (parent && byId.has(parent.chartId)) {
      const p = byId.get(parent.chartId);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const x1 = p.x + p.w / 2;
      const y1 = p.y + p.h;
      const x2 = pos.x + pos.w / 2;
      const y2 = pos.y;
      line.setAttribute(
        "d",
        `M ${x1} ${y1} C ${x1} ${y1 + 18}, ${x2} ${y2 - 18}, ${x2} ${y2}`
      );
      line.setAttribute("class", "chart-flow__edge");
      svg.appendChild(line);
    }
  }

  for (const pos of positions) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    bindChartItem(g, pos.chartId);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(pos.x));
    rect.setAttribute("y", String(pos.y));
    rect.setAttribute("width", String(pos.w));
    rect.setAttribute("height", String(pos.h));
    rect.setAttribute("rx", "6");
    rect.setAttribute("class", "chart-flow__node");
    rect.setAttribute("stroke", severityColor(pos.node.severity || "ok"));

    const t1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t1.setAttribute("x", String(pos.x + 8));
    t1.setAttribute("y", String(pos.y + 18));
    t1.setAttribute("class", "chart-flow__type");
    t1.textContent = truncate(pos.node.nodeType || "Plan", 16);

    const t2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t2.setAttribute("x", String(pos.x + 8));
    t2.setAttribute("y", String(pos.y + 34));
    t2.setAttribute("class", "chart-flow__meta");
    const val = nodeMetric(pos.node, metric);
    t2.textContent = val ? formatCompact(val) : "—";

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = pos.node.title;
    rect.appendChild(title);

    g.append(rect, t1, t2);
    svg.appendChild(g);
  }
}

function findParent(root, chartId, parent = null) {
  if (root.chartId === chartId) return parent;
  for (const child of root.children || []) {
    const found = findParent(child, chartId, root);
    if (found) return found;
  }
  return null;
}

const JOIN_TYPES = new Set(["Nested Loop", "Hash Join", "Merge Join"]);

function tableKey(ref) {
  const name = ref.schema ? `${ref.schema}.${ref.relation}` : ref.relation;
  return name.toLowerCase();
}

function relationFromNode(node) {
  if (node.relationName) {
    return {
      relation: node.relationName,
      schema: node.schema,
      alias: node.alias,
      isCte: node.nodeType === "CTE Scan" || node.isCte,
      chartId: node.chartId,
    };
  }
  const match = node.title.match(/\bon\s+([^\s(]+)(?:\s+([^\s(]+))?/i);
  if (!match) return null;
  return {
    relation: match[1],
    schema: null,
    alias: match[2] || null,
    isCte: node.nodeType === "CTE Scan" || node.isCte,
    chartId: node.chartId,
  };
}

function collectRelations(node, list = []) {
  const ref = relationFromNode(node);
  if (ref && !ref.isCte) list.push(ref);
  for (const child of node.children || []) collectRelations(child, list);
  return list;
}

function extractJoinCondition(node) {
  for (const line of node.details || []) {
    const match = line.match(/^(?:Hash Cond|Merge Cond|Join Filter|Filter):\s*(.+)/i);
    if (match) return match[1].trim();
  }
  return null;
}

function buildTableGraph(tree) {
  const tables = new Map();
  const edges = [];

  function ensureTable(ref) {
    const id = tableKey(ref);
    if (!tables.has(id)) {
      tables.set(id, {
        id,
        label: ref.relation,
        schema: ref.schema,
        alias: ref.alias || ref.relation,
        chartIds: [],
      });
    }
    const table = tables.get(id);
    if (ref.chartId && !table.chartIds.includes(ref.chartId)) {
      table.chartIds.push(ref.chartId);
    }
    return id;
  }

  function walk(node) {
    if (JOIN_TYPES.has(node.nodeType) && node.children?.length >= 2) {
      const condition = extractJoinCondition(node);
      const branchIds = node.children.map((child) => {
        const refs = collectRelations(child);
        const ids = [...new Set(refs.map((ref) => ensureTable(ref)))];
        return ids;
      });

      for (let i = 0; i < branchIds.length; i++) {
        for (let j = i + 1; j < branchIds.length; j++) {
          for (const from of branchIds[i]) {
            for (const to of branchIds[j]) {
              if (from === to) continue;
              const pair = from < to ? `${from}|${to}` : `${to}|${from}`;
              edges.push({
                pair,
                from,
                to,
                joinType: node.nodeType,
                condition,
                chartId: node.chartId,
              });
            }
          }
        }
      }
    }

    for (const child of node.children || []) walk(child);
  }

  walk(tree);
  collectRelations(tree).forEach((ref) => ensureTable(ref));

  const uniqueEdges = [];
  const seen = new Set();
  for (const edge of edges) {
    const key = `${edge.pair}|${edge.joinType}|${edge.condition || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueEdges.push(edge);
  }

  return { tables: [...tables.values()], edges: uniqueEdges };
}

function joinTypeShort(joinType) {
  const map = {
    "Nested Loop": "Nested",
    "Hash Join": "Hash",
    "Merge Join": "Merge",
  };
  return map[joinType] || joinType;
}

function layoutTableNodes(tables, width, height) {
  const boxW = 148;
  const boxH = 58;
  const count = tables.length;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(140, Math.min(width, height) * 0.38 - boxW / 2, count * 28);

  return tables.map((table, index) => {
    const angle = count === 1 ? 0 : (2 * Math.PI * index) / count - Math.PI / 2;
    return {
      ...table,
      w: boxW,
      h: boxH,
      x: cx + radius * Math.cos(angle) - boxW / 2,
      y: cy + radius * Math.sin(angle) - boxH / 2,
      cx: cx + radius * Math.cos(angle),
      cy: cy + radius * Math.sin(angle),
    };
  });
}

function renderTableJoinsChart(svg, tree) {
  const graph = buildTableGraph(tree);
  const count = Math.max(graph.tables.length, graph.edges.length, 1);
  const width = Math.max(960, count * 110);
  const height = Math.max(420, count * 72 + 120);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (!graph.tables.length) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "28");
    text.setAttribute("class", "chart-empty");
    text.textContent = "Таблицы в плане не найдены";
    svg.appendChild(text);
    return;
  }

  const positions = layoutTableNodes(graph.tables, width, height);
  const byId = new Map(positions.map((p) => [p.id, p]));

  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    bindChartItem(g, edge.chartId);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const mx = (from.cx + to.cx) / 2;
    const my = (from.cy + to.cy) / 2;
    const dx = to.cx - from.cx;
    const dy = to.cy - from.cy;
    const curve = Math.min(48, Math.hypot(dx, dy) * 0.2);
    path.setAttribute(
      "d",
      `M ${from.cx} ${from.cy} Q ${mx - dy * 0.12} ${my + curve} ${to.cx} ${to.cy}`
    );
    path.setAttribute("class", "chart-tables__edge");

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = [
      edge.joinType,
      edge.condition || "условие не указано в плане",
    ].join("\n");
    path.appendChild(title);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(mx));
    label.setAttribute("y", String(my - 4));
    label.setAttribute("class", "chart-tables__edge-label");
    label.textContent = joinTypeShort(edge.joinType);

    g.append(path, label);
    svg.appendChild(g);

    if (edge.condition) {
      const cond = document.createElementNS("http://www.w3.org/2000/svg", "text");
      cond.setAttribute("x", String(mx));
      cond.setAttribute("y", String(my + 12));
      cond.setAttribute("class", "chart-tables__cond");
      cond.textContent = truncate(edge.condition, 42);
      svg.appendChild(cond);
    }
  }

  for (const pos of positions) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    bindChartItem(g, pos.chartIds.length ? pos.chartIds : null);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(pos.x));
    rect.setAttribute("y", String(pos.y));
    rect.setAttribute("width", String(pos.w));
    rect.setAttribute("height", String(pos.h));
    rect.setAttribute("rx", "8");
    rect.setAttribute("class", "chart-tables__node");

    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.setAttribute("x", String(pos.x + pos.w / 2));
    title.setAttribute("y", String(pos.y + 22));
    title.setAttribute("class", "chart-tables__name");
    title.textContent = truncate(pos.label, 18);

    const alias = document.createElementNS("http://www.w3.org/2000/svg", "text");
    alias.setAttribute("x", String(pos.x + pos.w / 2));
    alias.setAttribute("y", String(pos.y + 40));
    alias.setAttribute("class", "chart-tables__alias");
    const aliasText = pos.alias && pos.alias !== pos.label ? `as ${pos.alias}` : pos.schema || "table";
    alias.textContent = truncate(aliasText, 20);

    const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
    tip.textContent = pos.schema ? `${pos.schema}.${pos.label}` : pos.label;
    rect.appendChild(tip);

    g.append(rect, title, alias);
    svg.appendChild(g);
  }
}

function renderCharts(root, tree, metric) {
  currentMetric = metric;
  const flat = collectFlatNodes(tree);

  const treemapSvg = root.querySelector("#chart-treemap-svg");
  const barsSvg = root.querySelector("#chart-bars-svg");
  const tablesSvg = root.querySelector("#chart-tables-svg");
  const flowSvg = root.querySelector("#chart-flow-svg");

  treemapSvg.replaceChildren();
  barsSvg.replaceChildren();
  tablesSvg.replaceChildren();
  flowSvg.replaceChildren();

  renderTreemap(treemapSvg, flat, metric);
  renderBarChart(barsSvg, flat, metric);
  renderTableJoinsChart(tablesSvg, tree);
  renderFlowChart(flowSvg, tree, metric);

  root.querySelectorAll(".metric-tab").forEach((btn) => {
    btn.classList.toggle("metric-tab--active", btn.dataset.metric === metric);
  });
}

function initChartsSection(section, tree) {
  section._explainTree = tree;

  if (!section.dataset.bound) {
    section.dataset.bound = "1";
    section.querySelectorAll(".metric-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        renderCharts(section, section._explainTree, btn.dataset.metric);
      });
    });
  }

  renderCharts(section, tree, currentMetric);
}

function hideChartsSection(section) {
  if (section) section._explainTree = null;
}
