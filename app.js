const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

const hubLink = document.getElementById("hub-link");
if (hubLink) {
  hubLink.href = isLocal
    ? window.TOOLS_HUB_LOCAL_URL ?? window.TOOLS_HUB_URL
    : window.TOOLS_HUB_URL;
}

const inputEl = document.getElementById("explain-input");
const summaryEl = document.getElementById("summary");
const hotspotsEl = document.getElementById("hotspots");
const insightsEl = document.getElementById("insights");
const treeEl = document.getElementById("plan-tree");
const errorEl = document.getElementById("parse-error");
const formatEl = document.getElementById("detected-format");
const loadSampleBtn = document.getElementById("load-sample");

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
  const pct = Math.min(100, Math.round((ratio || 0) * 100));
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
    const items = [
      ["cost", formatCost(node.costStart, node.costEnd)],
      ["rows", formatCompact(node.planRows)],
      ["width", node.width ?? "—"],
    ];
    if (node.actualTimeEnd != null) {
      items.push([
        "actual",
        `${node.actualTimeStart ?? 0}..${node.actualTimeEnd} ms`,
      ]);
      items.push(["actual rows", formatCompact(node.actualRows)]);
      items.push(["loops", node.loops ?? "—"]);
    }
    metrics.innerHTML = items
      .map(
        ([k, v]) =>
          `<span class="metric"><span class="label">${k}</span> ${v}</span>`
      )
      .join("");
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
  summaryEl.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item card">
        <p class="label">формат</p>
        <p class="body">${format}</p>
      </div>
      <div class="summary-item card">
        <p class="label">узлов</p>
        <p class="body">${analysis.totalNodes}</p>
      </div>
      <div class="summary-item card summary-item--critical">
        <p class="label">критично</p>
        <p class="body">${analysis.criticalCount}</p>
      </div>
      <div class="summary-item card summary-item--warn">
        <p class="label">внимание</p>
        <p class="body">${analysis.warnCount}</p>
      </div>
      <div class="summary-item card">
        <p class="label">max cost</p>
        <p class="body">${formatCompact(analysis.maxCost)}</p>
      </div>
      <div class="summary-item card">
        <p class="label">max rows</p>
        <p class="body">${formatCompact(analysis.maxRows)}</p>
      </div>
      <div class="summary-item card">
        <p class="label">planning</p>
        <p class="body">${formatMs(meta.planningTimeMs)}</p>
      </div>
      <div class="summary-item card">
        <p class="label">execution</p>
        <p class="body">${formatMs(meta.executionTimeMs)}</p>
      </div>
    </div>
  `;
}

function renderHotspots(hotspots) {
  hotspotsEl.innerHTML = "";
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
    li.innerHTML = `
      <span class="hotspot__rank">${i + 1}</span>
      <span class="hotspot__body">
        <span class="hotspot__title">${escapeHtml(n.title)}</span>
        <span class="hotspot__meta">cost ${formatCompact(n.costEnd)} · rows ${formatCompact(n.planRows)}</span>
      </span>
    `;
    list.appendChild(li);
  });

  hotspotsEl.append(heading, list);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInsights(insights) {
  insightsEl.innerHTML = "";
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

function render() {
  const result = parseExplain(inputEl.value);

  if (result.error) {
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    summaryEl.innerHTML = "";
    hotspotsEl.hidden = true;
    insightsEl.hidden = true;
    treeEl.innerHTML = "";
    formatEl.textContent = "";
    return;
  }

  errorEl.hidden = true;
  formatEl.textContent = result.format === "json" ? "JSON" : "TEXT";
  renderSummary(result.meta, result.format, result.analysis);
  renderHotspots(result.analysis.hotspots);
  renderInsights(buildInsights(result));
  treeEl.innerHTML = "";
  treeEl.appendChild(renderNode(result.tree));
}

if (loadSampleBtn) {
  loadSampleBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("sample-explain.txt");
      if (res.ok) {
        inputEl.value = await res.text();
        render();
      }
    } catch {
      /* локально без sample */
    }
  });
}

inputEl.addEventListener("input", render);
render();
