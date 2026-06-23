const hubLink = document.getElementById("hub-link");
if (hubLink) {
  hubLink.href = window.TOOLS_HUB_URL;
}

const inputEl = document.getElementById("explain-input");
const sqlInputEl = document.getElementById("sql-input");
const summaryEl = document.getElementById("summary");
const hotspotsEl = document.getElementById("hotspots");
const insightsEl = document.getElementById("insights");
const treeEl = document.getElementById("plan-tree");
const planCteGroupsEl = document.getElementById("plan-cte-groups");
const chartsSectionEl = document.getElementById("charts-section");
const tabParseEl = document.getElementById("tab-parse");
const tabChartsEl = document.getElementById("tab-charts");
const tabBtnParseEl = document.getElementById("tab-btn-parse");
const tabBtnChartsEl = document.getElementById("tab-btn-charts");
const tabAnalyticsEl = document.getElementById("tab-analytics");
const tabBtnAnalyticsEl = document.getElementById("tab-btn-analytics");
const analyticsRootEl = document.getElementById("analytics-root");
const errorEl = document.getElementById("parse-error");
const formatEl = document.getElementById("detected-format");
const pasteBtn = document.getElementById("paste-btn");
const clearBtn = document.getElementById("clear-btn");
const collapseBtn = document.getElementById("collapse-btn");
const copySummaryBtn = document.getElementById("copy-summary-btn");
const toastEl = document.getElementById("toast");
const sqlFragmentsEl = document.getElementById("sql-fragments");
const sqlEditorWrap = document.getElementById("sql-editor-wrap");
const sqlEditToggle = document.getElementById("sql-edit-toggle");

const MAX_INPUT_CHARS = 1_500_000;
let lastResult = null;
let allExpanded = true;
let sqlViewMode = "fragments";

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
  if (node.isVirtualCte) {
    article.classList.add("plan-node--virtual-cte");
  }
  if (node.chartId) {
    article.dataset.chartId = node.chartId;
  }

  const head = document.createElement("div");
  head.className = "plan-node__head";
  head.setAttribute("tabindex", "0");
  head.setAttribute("aria-expanded", "true");

  const badge = document.createElement("span");
  badge.className = `plan-node__badge plan-node__badge--${severity}`;
  badge.textContent = node.nodeType || "Plan";

  const title = document.createElement("h3");
  title.className = "plan-node__title";
  title.textContent = node.title;

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "plan-node__toggle";
  toggleBtn.textContent = "▾";
  toggleBtn.setAttribute("aria-label", "Свернуть или развернуть узел");

  head.append(badge, title);
  if (node.attributedCtes?.length) {
    for (const cteName of node.attributedCtes) {
      const tag = document.createElement("span");
      tag.className = "plan-node__cte-tag";
      tag.textContent = cteName;
      head.appendChild(tag);
    }
  }
  if (node.issues?.length) {
    const pill = document.createElement("span");
    pill.className = `plan-node__severity plan-node__severity--${severity}`;
    pill.textContent = severityLabel(severity);
    head.appendChild(pill);
  }

  const toggleCollapse = () => {
    const collapsed = article.classList.toggle("plan-node--collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
    toggleBtn.textContent = collapsed ? "▸" : "▾";
  };

  const selectNode = () => {
    treeEl.querySelectorAll(".plan-node--highlight").forEach((el) => {
      el.classList.remove("plan-node--highlight");
    });
    article.classList.add("plan-node--highlight");
    if (lastResult?.analytics?.hasSql) {
      const link = resolveSqlLinkForNode(node, lastResult.analytics);
      if (link) highlightSqlLink(link);
    }
  };

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCollapse();
  });
  head.addEventListener("click", selectNode);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectNode();
    }
  });

  head.appendChild(toggleBtn);
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

function switchResultsTab(tabId) {
  const panels = {
    parse: tabParseEl,
    charts: tabChartsEl,
    analytics: tabAnalyticsEl,
  };
  const buttons = {
    parse: tabBtnParseEl,
    charts: tabBtnChartsEl,
    analytics: tabBtnAnalyticsEl,
  };

  for (const [id, panel] of Object.entries(panels)) {
    const active = id === tabId;
    panel.hidden = !active;
    panel.classList.toggle("results-panel--active", active);
    buttons[id].classList.toggle("results-tab--active", active);
    buttons[id].setAttribute("aria-selected", String(active));
  }
}

function showResultTabs(show) {
  tabBtnChartsEl.hidden = !show;
  tabBtnAnalyticsEl.hidden = !show;
  if (!show) {
    switchResultsTab("parse");
  }
}

if (tabBtnParseEl) {
  [tabBtnParseEl, tabBtnChartsEl, tabBtnAnalyticsEl].forEach((btn) => {
    btn?.addEventListener("click", () => switchResultsTab(btn.dataset.tab));
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSqlWithTableMarks(sql, tables) {
  if (!sql) return "";
  let html = escapeHtml(sql);
  const sorted = [...(tables || [])].sort((a, b) => b.table.length - a.table.length);
  for (const table of sorted) {
    const re = new RegExp(`\\b(${escapeRegExp(table.table)})\\b`, "gi");
    html = html.replace(
      re,
      `<mark class="sql-mark" data-table-key="${table.key}">$1</mark>`
    );
  }
  return html;
}

function findNodeByChartId(node, chartId) {
  if (node.chartId === chartId) return node;
  for (const child of node.children || []) {
    const found = findNodeByChartId(child, chartId);
    if (found) return found;
  }
  return null;
}

function highlightSqlLink(link) {
  if (!link || !sqlFragmentsEl) return;

  document.querySelectorAll(".sql-frag--active").forEach((el) => {
    el.classList.remove("sql-frag--active");
  });
  document.querySelectorAll(".sql-mark--active").forEach((el) => {
    el.classList.remove("sql-mark--active");
  });

  const frag = sqlFragmentsEl.querySelector(`[data-frag-id="${link.fragId}"]`);
  if (frag) {
    frag.classList.add("sql-frag--active");
    frag.scrollIntoView({ behavior: "smooth", block: "nearest" });
    sqlFragmentsEl.closest(".workspace__sources")?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }

  if (link.tableKey && frag) {
    frag.querySelectorAll(`[data-table-key="${link.tableKey}"]`).forEach((el) => {
      el.classList.add("sql-mark--active");
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
}

function setSqlViewMode(mode) {
  sqlViewMode = mode;
  const showFragments = mode === "fragments";
  if (sqlFragmentsEl) sqlFragmentsEl.hidden = !showFragments;
  if (sqlEditorWrap) sqlEditorWrap.hidden = showFragments;
  if (sqlEditToggle) {
    sqlEditToggle.textContent = showFragments ? "Редактировать" : "Фрагменты";
  }
}

function renderSqlFragments(analytics) {
  if (!sqlFragmentsEl) return;

  sqlFragmentsEl.replaceChildren();
  const frags = analytics?.fragments?.filter((f) => f.kind === "cte" || f.kind === "main") || [];
  const hasContent = analytics?.hasSql && frags.some((f) => f.sql || f.preview);

  if (!hasContent) {
    sqlFragmentsEl.hidden = true;
    setSqlViewMode("editor");
    if (sqlEditToggle) sqlEditToggle.hidden = true;
    return;
  }

  if (sqlEditToggle) sqlEditToggle.hidden = false;
  if (sqlViewMode !== "editor") {
    setSqlViewMode("fragments");
  }

  for (const frag of frags) {
    const sqlText = frag.sql || frag.preview;
    if (!sqlText) continue;

    const block = document.createElement("article");
    block.className = `sql-frag card sql-frag--${frag.kind}`;
    block.dataset.fragId = frag.id;
    block.setAttribute("tabindex", "0");
    block.setAttribute("role", "button");

    const head = document.createElement("div");
    head.className = "sql-frag__head";
    const title = document.createElement("h3");
    title.className = "sql-frag__title";
    title.textContent = frag.kind === "cte" ? `CTE · ${frag.name}` : "Основной запрос";
    const pct = document.createElement("span");
    pct.className = "sql-frag__pct";
    pct.textContent = `${Math.round(frag.costPct)}% cost`;
    head.append(title, pct);

    const code = document.createElement("pre");
    code.className = "sql-frag__code";
    code.innerHTML = renderSqlWithTableMarks(sqlText, frag.tables || []);

    block.append(head, code);

    const activate = () => {
      highlightSqlLink({ fragId: frag.id, tableKey: null });
      if (frag.chartIds?.length) highlightPlanNode(frag.chartIds, false);
    };
    block.addEventListener("click", activate);
    block.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    sqlFragmentsEl.appendChild(block);
  }
}

function cteMatchLabel(method) {
  const map = {
    plan_cte: "CTE в EXPLAIN",
    cte_scan: "CTE Scan",
    subquery_scan: "Subquery Scan",
    inferred_tables: "inline · по таблицам",
    unmatched: "не сопоставлено",
  };
  return map[method] || method;
}

function renderCtePlanGroups(analytics) {
  planCteGroupsEl.replaceChildren();
  const cteFrags = analytics?.fragments?.filter((f) => f.kind === "cte") || [];
  const visible = cteFrags.filter((f) => f.matchedPlan && f.chartIds?.length);

  if (!visible.length) {
    planCteGroupsEl.hidden = true;
    return;
  }

  planCteGroupsEl.hidden = false;
  const heading = document.createElement("h3");
  heading.className = "plan-cte-groups__title label";
  heading.textContent = "CTE в плане";
  planCteGroupsEl.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "body secondary plan-cte-groups__hint";
  hint.textContent =
    "PostgreSQL часто встраивает CTE без отдельных узлов — ниже сопоставление по SQL и таблицам.";
  planCteGroupsEl.appendChild(hint);

  const list = document.createElement("div");
  list.className = "plan-cte-groups__list";

  visible.forEach((frag) => {
    const block = document.createElement("article");
    block.className = `card plan-cte-block${frag.inferred ? " plan-cte-block--inferred" : ""}`;

    const head = document.createElement("div");
    head.className = "plan-cte-block__head";
    const name = document.createElement("h4");
    name.className = "plan-cte-block__name";
    name.textContent = frag.name;
    const method = document.createElement("span");
    method.className = "plan-cte-block__method";
    method.textContent = cteMatchLabel(frag.matchMethod);
    const weight = document.createElement("span");
    weight.className = "plan-cte-block__weight";
    weight.textContent = `${Math.round(frag.costPct)}% cost`;
    head.append(name, method, weight);

    const metrics = document.createElement("p");
    metrics.className = "body secondary plan-cte-block__metrics";
    metrics.textContent = `cost ${formatCompact(frag.cost)} · rows ${formatCompact(frag.rows)} · ${frag.definition?.nodeCount || 0} узл.`;
    if (frag.timeMs > 0) metrics.textContent += ` · ${frag.timeMs.toFixed(2)} ms`;

    block.append(head, metrics);

    if (frag.topNodes?.length) {
      const nodes = document.createElement("ul");
      nodes.className = "plan-cte-block__nodes";
      frag.topNodes.forEach((node) => {
        const li = document.createElement("li");
        li.textContent = node.title;
        if (node.chartId) {
          li.classList.add("plan-cte-block__node--clickable");
          li.setAttribute("role", "button");
          li.setAttribute("tabindex", "0");
          const go = () => highlightPlanNode(node.chartId);
          li.addEventListener("click", go);
          li.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              go();
            }
          });
        }
        nodes.appendChild(li);
      });
      block.appendChild(nodes);
    }

    bindFragmentClick(block, frag.chartIds);
    list.appendChild(block);
  });

  planCteGroupsEl.appendChild(list);
}

function pctBarHtml(pct, mod = "cost") {
  const width = Math.min(100, Math.max(0, Math.round(pct)));
  return `<div class="bar-row"><div class="bar-track"><div class="bar bar--${mod}" style="width:${width}%"></div></div><span class="frag-pct">${width}%</span></div>`;
}

function bindFragmentClick(el, chartIds) {
  if (!chartIds?.length) return;
  el.classList.add("frag-card--clickable");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  const activate = () => highlightPlanNode(chartIds);
  el.addEventListener("click", activate);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
}

function renderAnalytics(analytics) {
  analyticsRootEl.replaceChildren();
  if (!analytics) return;

  const head = document.createElement("div");
  head.className = "analytics__head";
  const title = document.createElement("h3");
  title.className = "h1 analytics__title";
  title.textContent = "Связка SQL ↔ план";
  const hint = document.createElement("p");
  hint.className = "body secondary analytics__hint";
  hint.textContent = analytics.hasSql
    ? "Доля cost и времени по фрагментам запроса. Клик — подсветка узлов на вкладке «Разбор»."
    : "Добавьте SQL слева для привязки текста к плану. Ниже — разбор по структуре EXPLAIN.";
  head.append(title, hint);
  analyticsRootEl.appendChild(head);

  if (analytics.insights.length) {
    const box = document.createElement("ul");
    box.className = "insights analytics-insights";
    analytics.insights.forEach((item) => {
      const li = document.createElement("li");
      li.className = `insight insight--${item.level}`;
      li.textContent = item.text;
      box.appendChild(li);
    });
    analyticsRootEl.appendChild(box);
  }

  const weightCard = document.createElement("div");
  weightCard.className = "card analytics-card";
  const weightTitle = document.createElement("h4");
  weightTitle.className = "label analytics-card__title";
  weightTitle.textContent = "Вес фрагментов (cost)";
  weightCard.appendChild(weightTitle);

  const stack = document.createElement("div");
  stack.className = "weight-stack";
  analytics.fragments.forEach((frag) => {
    if (frag.costPct < 0.5 && frag.kind !== "main") return;
    const row = document.createElement("div");
    row.className = `weight-row weight-row--${frag.kind}`;
    const label = document.createElement("span");
    label.className = "weight-row__label";
    label.textContent = frag.name;
    const bar = document.createElement("div");
    bar.className = "weight-row__bar";
    bar.innerHTML = pctBarHtml(frag.costPct);
    const meta = document.createElement("span");
    meta.className = "weight-row__meta body secondary";
    meta.textContent = `cost ${formatCompact(frag.cost)} · rows ${formatCompact(frag.rows)}`;
    if (frag.timeMs > 0) {
      meta.textContent += ` · ${frag.timeMs.toFixed(2)} ms`;
    }
    row.append(label, bar, meta);
    bindFragmentClick(row, frag.chartIds);
    stack.appendChild(row);
  });
  weightCard.appendChild(stack);
  analyticsRootEl.appendChild(weightCard);

  const cteFragments = analytics.fragments.filter((f) => f.kind === "cte");
  if (cteFragments.length) {
    const section = document.createElement("section");
    section.className = "analytics-section";
    const sectionTitle = document.createElement("h4");
    sectionTitle.className = "label analytics-section__title";
    sectionTitle.textContent = `CTE · ${cteFragments.length}`;
    section.appendChild(sectionTitle);

    const list = document.createElement("div");
    list.className = "frag-list";
    cteFragments.forEach((frag) => {
      list.appendChild(renderFragmentCard(frag));
    });
    section.appendChild(list);
    analyticsRootEl.appendChild(section);
  }

  const mainFrag = analytics.fragments.find((f) => f.kind === "main");
  if (mainFrag) {
    const section = document.createElement("section");
    section.className = "analytics-section";
    const sectionTitle = document.createElement("h4");
    sectionTitle.className = "label analytics-section__title";
    sectionTitle.textContent = "Основной запрос";
    section.appendChild(sectionTitle);
    section.appendChild(renderFragmentCard(mainFrag));
    analyticsRootEl.appendChild(section);
  }

  if (analytics.tableFragments.length) {
    const section = document.createElement("section");
    section.className = "analytics-section";
    const sectionTitle = document.createElement("h4");
    sectionTitle.className = "label analytics-section__title";
    sectionTitle.textContent = `Таблицы · ${analytics.tableFragments.length}`;
    section.appendChild(sectionTitle);

    const grid = document.createElement("div");
    grid.className = "table-frag-grid";
    analytics.tableFragments.forEach((frag) => {
      const card = document.createElement("article");
      card.className = "card table-frag-card";
      const name = document.createElement("h5");
      name.className = "table-frag-card__name";
      name.textContent = frag.schema ? `${frag.schema}.${frag.name}` : frag.name;
      const meta = document.createElement("p");
      meta.className = "body secondary table-frag-card__meta";
      meta.textContent = `${frag.scanCount} scan(s) · ${Math.round(frag.costPct)}% cost`;
      const metrics = document.createElement("p");
      metrics.className = "body table-frag-card__metrics";
      metrics.textContent = `cost ${formatCompact(frag.cost)} · rows ${formatCompact(frag.rows)}`;
      card.append(name, meta, metrics);
      bindFragmentClick(card, frag.chartIds);
      grid.appendChild(card);
    });
    section.appendChild(grid);
    analyticsRootEl.appendChild(section);
  }
}

function renderFragmentCard(frag) {
  const card = document.createElement("article");
  card.className = `card frag-card frag-card--${frag.kind}${frag.unmatchedPlan ? " frag-card--warn" : ""}`;

  const head = document.createElement("div");
  head.className = "frag-card__head";
  const name = document.createElement("h5");
  name.className = "frag-card__name";
  name.textContent = frag.name;
  const badge = document.createElement("span");
  badge.className = "frag-card__badge";
  badge.textContent = frag.unmatchedPlan
    ? "нет в плане"
    : `${Math.round(frag.costPct)}% cost`;
  head.append(name, badge);

  if (frag.kind === "cte" && frag.matchMethod) {
    const method = document.createElement("span");
    method.className = "frag-card__method";
    method.textContent = cteMatchLabel(frag.matchMethod);
    head.appendChild(method);
  }

  const metrics = document.createElement("div");
  metrics.className = "frag-card__metrics";
  metrics.innerHTML = pctBarHtml(frag.costPct);
  const line = document.createElement("p");
  line.className = "body secondary";
  line.textContent = `cost ${formatCompact(frag.cost)} · rows ${formatCompact(frag.rows)}`;
  if (frag.timeMs > 0) line.textContent += ` · ${frag.timeMs.toFixed(2)} ms`;
  metrics.appendChild(line);

  if (frag.usage && frag.usage.totalTime > 0) {
    const usage = document.createElement("p");
    usage.className = "body secondary frag-card__usage";
    usage.textContent = `CTE Scan: ${frag.usage.totalTime.toFixed(2)} ms actual`;
    metrics.appendChild(usage);
  }

  card.append(head, metrics);

  if (frag.sql) {
    const pre = document.createElement("pre");
    pre.className = "frag-card__sql";
    pre.textContent = frag.preview || frag.sql;
    card.appendChild(pre);
  } else if (frag.preview) {
    const pre = document.createElement("pre");
    pre.className = "frag-card__sql frag-card__sql--muted";
    pre.textContent = frag.preview;
    card.appendChild(pre);
  }

  if (frag.topNodes?.length) {
    const tops = document.createElement("ul");
    tops.className = "frag-card__tops";
    frag.topNodes.forEach((node) => {
      const li = document.createElement("li");
      li.className = "frag-top-node";
      li.textContent = `${node.title} · cost ${formatCompact(node.costEnd)}`;
      if (node.chartId) {
        li.classList.add("frag-top-node--clickable");
        li.setAttribute("role", "button");
        li.setAttribute("tabindex", "0");
        const activate = () => highlightPlanNode(node.chartId);
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          activate();
        });
        li.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            activate();
          }
        });
      }
      tops.appendChild(li);
    });
    card.appendChild(tops);
  }

  if (frag.unmatchedPlan) {
    const warn = document.createElement("p");
    warn.className = "frag-card__warn";
    warn.textContent =
      "Узлы не найдены — CTE полностью inline или таблицы совпадают с основным запросом";
    card.appendChild(warn);
  }

  bindFragmentClick(card, frag.chartIds);
  return card;
}

function highlightPlanNode(chartIds, scrollToPlan = true) {
  const ids = Array.isArray(chartIds) ? chartIds : [chartIds];
  const idSet = new Set(ids.filter(Boolean));

  treeEl.querySelectorAll(".plan-node").forEach((el) => {
    el.classList.toggle("plan-node--highlight", idSet.has(el.dataset.chartId));
  });

  if (scrollToPlan) {
    switchResultsTab("parse");
  }

  const target = ids
    .map((id) => treeEl.querySelector(`[data-chart-id="${id}"]`))
    .find(Boolean);

  if (lastResult?.analytics?.hasSql && target?.dataset.chartId) {
    const planNode = findNodeByChartId(lastResult.tree, target.dataset.chartId);
    if (planNode) {
      const link = resolveSqlLinkForNode(planNode, lastResult.analytics);
      if (link) highlightSqlLink(link);
    }
  }

  if (!target || !scrollToPlan) return;

  requestAnimationFrame(() => {
    let parent = target.parentElement;
    while (parent) {
      if (parent.classList?.contains("plan-node")) {
        parent.classList.remove("plan-node--collapsed");
        const head = parent.querySelector(".plan-node__head");
        if (head) head.setAttribute("aria-expanded", "true");
      }
      parent = parent.parentElement;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

setChartNodeHandler(highlightPlanNode);

function render() {
  const raw = inputEl.value;
  if (raw.length > MAX_INPUT_CHARS) {
    errorEl.textContent = `Слишком большой ввод (макс. ${MAX_INPUT_CHARS.toLocaleString("ru")} символов)`;
    errorEl.hidden = false;
    summaryEl.replaceChildren();
    hotspotsEl.hidden = true;
    insightsEl.hidden = true;
    hideChartsSection(chartsSectionEl);
    showResultTabs(false);
    analyticsRootEl.replaceChildren();
    planCteGroupsEl.replaceChildren();
    planCteGroupsEl.hidden = true;
    if (sqlFragmentsEl) {
      sqlFragmentsEl.replaceChildren();
      sqlFragmentsEl.hidden = true;
    }
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
    hideChartsSection(chartsSectionEl);
    showResultTabs(false);
    analyticsRootEl.replaceChildren();
    planCteGroupsEl.replaceChildren();
    planCteGroupsEl.hidden = true;
    if (sqlFragmentsEl) {
      sqlFragmentsEl.replaceChildren();
      sqlFragmentsEl.hidden = true;
    }
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

  resetChartIds();
  assignChartIds(result.tree);

  const analytics = buildFragmentAnalytics(result.tree, sqlInputEl?.value || "", result.analysis);
  result.analytics = analytics;
  renderAnalytics(analytics);
  renderCtePlanGroups(analytics);
  renderSqlFragments(analytics);

  treeEl.replaceChildren();
  treeEl.appendChild(renderNode(result.tree));
  initChartsSection(chartsSectionEl, result.tree);
  showResultTabs(true);
  if (!allExpanded) {
    setAllNodesCollapsed(true);
  }
}

inputEl.addEventListener("input", render);
sqlInputEl?.addEventListener("input", render);
pasteBtn?.addEventListener("click", pasteInput);
clearBtn?.addEventListener("click", () => {
  inputEl.value = "";
  if (sqlInputEl) sqlInputEl.value = "";
  render();
  inputEl.focus();
});
collapseBtn?.addEventListener("click", () => {
  if (!treeEl.children.length) return;
  setAllNodesCollapsed(allExpanded);
});
copySummaryBtn?.addEventListener("click", copySummary);

sqlEditToggle?.addEventListener("click", () => {
  setSqlViewMode(sqlViewMode === "fragments" ? "editor" : "fragments");
});

render();
