const hubLink = document.getElementById("hub-link");
if (hubLink) {
  hubLink.href = window.TOOLS_HUB_URL;
}

const inputEl = document.getElementById("explain-input");
const summaryEl = document.getElementById("summary");
const hotspotsEl = document.getElementById("hotspots");
const insightsEl = document.getElementById("insights");
const treeEl = document.getElementById("plan-tree");
const errorEl = document.getElementById("parse-error");
const formatEl = document.getElementById("detected-format");
const pasteBtn = document.getElementById("paste-btn");
const clearBtn = document.getElementById("clear-btn");
const collapseBtn = document.getElementById("collapse-btn");
const copySummaryBtn = document.getElementById("copy-summary-btn");
const toastEl = document.getElementById("toast");

const MAX_INPUT_CHARS = 1_500_000;
let lastResult = null;
let allExpanded = true;

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

function formatMs(ms) {
  if (ms == null) return "—";
  return `${ms} ms`;
}

function formatCost(start, end) {
  if (start == null && end == null) return "—";
  const s = start != null ? formatCompact(start) : "?";
  const e = end != null ? formatCompact(end) : "?";
  return `${s}..${e}`;
}

function barHtml(ratio, kind) {
  const pct = Math.min(100, Math.max(0, Math.round((ratio || 0) * 100)));
  return `<div class="bar bar--${kind}" style="width:${pct}%" title="${pct}% от максимума"></div>`;
}

function severityLabel(severity) {
  const map = {
    critical: "критично",
    warn: "внимание",
    ok: "норма",
  };
  return map[severity] || severity;
}

function appendMetric(parent, key, value) {
  const span = document.createElement("span");
  span.className = "metric";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = key;
  span.appendChild(label);
  span.appendChild(document.createTextNode(` ${String(value)}`));
  parent.appendChild(span);
}

function renderNode(node, depth = 0) {
  const article = document.createElement("article");
  article.className = "plan-node card";
  article.style.setProperty("--depth", String(depth));

  const severity = node.severity || "ok";
  if (severity !== "ok") {
    article.classList.add(`plan-node--${severity}`);
  }
  if (node.isCte) {
    article.classList.add("plan-node--cte");
  }

  const head = document.createElement("div");
  head.className = "plan-node__head";
  head.setAttribute("role", "button");
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-expanded", "true");

  const badge = document.createElement("span");
  badge.className = `plan-node__badge plan-node__badge--${severity}`;
  badge.textContent = node.nodeType || "Plan";

  const title = document.createElement("h3");
  title.className = "plan-node__title";
  title.textContent = node.title;

  head.append(badge, title);
  if (node.issues?.length) {
    const pill = document.createElement("span");
    pill.className = `plan-node__severity plan-node__severity--${severity}`;
    pill.textContent = severityLabel(severity);
    head.appendChild(pill);
  }

  const toggleCollapse = () => {
    const collapsed = article.classList.toggle("plan-node--collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
  };
  head.addEventListener("click", toggleCollapse);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapse();
    }
  });

  article.appendChild(head);

  if (node.costEnd != null || node.planRows != null) {
    const bars = document.createElement("div");
    bars.className = "plan-node__bars";
    if (node.costRatio != null) {
      bars.innerHTML += `<div class="bar-row"><span class="label">cost</span><div class="bar-track">${barHtml(node.costRatio, "cost")}</div></div>`;
    }
    if (node.rowsRatio != null && node.planRows != null) {
      bars.innerHTML += `<div class="bar-row"><span class="label">rows</span><div class="bar-track">${barHtml(node.rowsRatio, "rows")}</div></div>`;
    }
    article.appendChild(bars);

    const metrics = document.createElement("div");
    metrics.className = "plan-node__metrics";
    appendMetric(metrics, "cost", formatCost(node.costStart, node.costEnd));
    appendMetric(metrics, "rows", formatCompact(node.planRows));
    appendMetric(metrics, "width", node.width ?? "—");
    if (node.actualTimeEnd != null) {
      appendMetric(
        metrics,
        "actual",
        `${node.actualTimeStart ?? 0}..${node.actualTimeEnd} ms`
      );
      appendMetric(metrics, "actual rows", formatCompact(node.actualRows));
      appendMetric(metrics, "loops", node.loops ?? "—");
    }
    article.appendChild(metrics);
  }

  if (node.issues?.length) {
    const issues = document.createElement("ul");
    issues.className = "plan-node__issues";
    node.issues.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      issues.appendChild(li);
    });
    article.appendChild(issues);
  }

  if (node.details?.length) {
    const ul = document.createElement("ul");
    ul.className = "plan-node__details";
    node.details.forEach((d) => {
      const li = document.createElement("li");
      li.className = "body secondary";
      li.textContent = d.length > 220 ? `${d.slice(0, 220)}…` : d;
      if (d.length > 220) li.title = d;
      ul.appendChild(li);
    });
    article.appendChild(ul);
  }

  if (node.children?.length) {
    const childWrap = document.createElement("div");
    childWrap.className = "plan-node__children";
    node.children.forEach((child) => {
      childWrap.appendChild(renderNode(child, depth + 1));
    });
    article.appendChild(childWrap);
  }

  return article;
}

function renderSummary(meta, format, analysis) {
  summaryEl.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "summary-grid";

  const items = [
    ["формат", format],
    ["узлов", analysis.totalNodes],
    ["критично", analysis.criticalCount, "critical"],
    ["внимание", analysis.warnCount, "warn"],
    ["max cost", formatCompact(analysis.maxCost)],
    ["max rows", formatCompact(analysis.maxRows)],
    ["planning", formatMs(meta.planningTimeMs)],
    ["execution", formatMs(meta.executionTimeMs)],
  ];

  items.forEach(([label, value, mod]) => {
    const box = document.createElement("div");
    box.className = `summary-item card${mod ? ` summary-item--${mod}` : ""}`;
    const pLabel = document.createElement("p");
    pLabel.className = "label";
    pLabel.textContent = label;
    const pVal = document.createElement("p");
    pVal.className = "body";
    pVal.textContent = String(value);
    box.append(pLabel, pVal);
    grid.appendChild(box);
  });

  summaryEl.appendChild(grid);
}

function renderHotspots(hotspots) {
  hotspotsEl.replaceChildren();
  if (!hotspots.length) {
    hotspotsEl.hidden = true;
    return;
  }
  hotspotsEl.hidden = false;

  const heading = document.createElement("h3");
  heading.className = "hotspots-heading label";
  heading.textContent = "топ по cost";

  const list = document.createElement("ol");
  list.className = "hotspots-list";

  hotspots.forEach((n, i) => {
    const li = document.createElement("li");
    li.className = `hotspot hotspot--${n.severity || "ok"}`;

    const rank = document.createElement("span");
    rank.className = "hotspot__rank";
    rank.textContent = String(i + 1);

    const body = document.createElement("span");
    body.className = "hotspot__body";

    const title = document.createElement("span");
    title.className = "hotspot__title";
    title.textContent = n.title;

    const meta = document.createElement("span");
    meta.className = "hotspot__meta";
    meta.textContent = `cost ${formatCompact(n.costEnd)} · rows ${formatCompact(n.planRows)}`;

    body.append(title, meta);
    li.append(rank, body);
    list.appendChild(li);
  });

  hotspotsEl.append(heading, list);
}

function renderInsights(insights) {
  insightsEl.replaceChildren();
  if (!insights.length) {
    insightsEl.hidden = true;
    return;
  }
  insightsEl.hidden = false;

  const heading = document.createElement("h3");
  heading.className = "insights-heading label";
  heading.textContent = "выводы";

  const list = document.createElement("ul");
  list.className = "insights";
  insights.forEach((item) => {
    const li = document.createElement("li");
    li.className = `insight insight--${item.level}`;
    li.textContent = item.text;
    list.appendChild(li);
  });
  insightsEl.append(heading, list);
}

function setAllNodesCollapsed(collapsed) {
  treeEl.querySelectorAll(".plan-node").forEach((node) => {
    node.classList.toggle("plan-node--collapsed", collapsed);
    const head = node.querySelector(".plan-node__head");
    if (head) head.setAttribute("aria-expanded", String(!collapsed));
  });
  allExpanded = !collapsed;
  if (collapseBtn) {
    collapseBtn.textContent = collapsed ? "Развернуть всё" : "Свернуть всё";
  }
}

function buildSummaryText(result) {
  const { meta, format, analysis } = result;
  return [
    `format: ${format}`,
    `nodes: ${analysis.totalNodes}`,
    `critical: ${analysis.criticalCount}`,
    `warn: ${analysis.warnCount}`,
    `max cost: ${formatCompact(analysis.maxCost)}`,
    `max rows: ${formatCompact(analysis.maxRows)}`,
    `planning: ${formatMs(meta.planningTimeMs)}`,
    `execution: ${formatMs(meta.executionTimeMs)}`,
  ].join("\n");
}

async function copySummary() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(buildSummaryText(lastResult));
    showToast("Сводка скопирована");
  } catch {
    showToast("Не удалось скопировать");
  }
}

async function pasteInput() {
  try {
    inputEl.value = await navigator.clipboard.readText();
    render();
    showToast("Вставлено");
  } catch {
    showToast("Нет доступа к буферу");
  }
}

function render() {
  const raw = inputEl.value;
  if (raw.length > MAX_INPUT_CHARS) {
    errorEl.textContent = `Слишком большой ввод (макс. ${MAX_INPUT_CHARS.toLocaleString("ru")} символов)`;
    errorEl.hidden = false;
    summaryEl.replaceChildren();
    hotspotsEl.hidden = true;
    insightsEl.hidden = true;
    treeEl.replaceChildren();
    formatEl.textContent = "";
    lastResult = null;
    return;
  }

  const result = parseExplain(raw);

  if (result.error) {
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    summaryEl.replaceChildren();
    hotspotsEl.hidden = true;
    insightsEl.hidden = true;
    treeEl.replaceChildren();
    formatEl.textContent = "";
    lastResult = null;
    return;
  }

  errorEl.hidden = true;
  lastResult = result;
  formatEl.textContent = result.format === "json" ? "JSON" : "TEXT";
  renderSummary(result.meta, result.format, result.analysis);
  renderHotspots(result.analysis.hotspots);
  renderInsights(buildInsights(result));
  treeEl.replaceChildren();
  treeEl.appendChild(renderNode(result.tree));
  if (!allExpanded) {
    setAllNodesCollapsed(true);
  }
}

inputEl.addEventListener("input", render);
pasteBtn?.addEventListener("click", pasteInput);
clearBtn?.addEventListener("click", () => {
  inputEl.value = "";
  render();
  inputEl.focus();
});
collapseBtn?.addEventListener("click", () => {
  if (!treeEl.children.length) return;
  setAllNodesCollapsed(allExpanded);
});
copySummaryBtn?.addEventListener("click", copySummary);

render();
