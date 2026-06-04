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
const insightsEl = document.getElementById("insights");
const treeEl = document.getElementById("plan-tree");
const errorEl = document.getElementById("parse-error");
const formatEl = document.getElementById("detected-format");

function formatMs(ms) {
  if (ms == null) return "—";
  return `${ms} ms`;
}

function formatCost(start, end) {
  if (start == null && end == null) return "—";
  return `${start ?? "?"}..${end ?? "?"}`;
}

function nodeWarnings(node) {
  const flags = [];
  if (
    node.actualRows != null &&
    node.planRows > 0 &&
    node.actualRows > node.planRows * 10
  ) {
    flags.push("rows");
  }
  if (node.actualTimeEnd != null && node.actualTimeEnd >= 100) {
    flags.push("slow");
  }
  return flags;
}

function renderNode(node, depth = 0) {
  const article = document.createElement("article");
  article.className = "plan-node card";
  article.style.marginLeft = `${depth * 12}px`;

  const flags = nodeWarnings(node);
  if (flags.length) {
    article.classList.add("plan-node--warn");
  }

  const title = document.createElement("h3");
  title.className = "plan-node__title";
  title.textContent = node.title;

  const metrics = document.createElement("div");
  metrics.className = "plan-node__metrics";

  const items = [
    ["cost", formatCost(node.costStart, node.costEnd)],
    ["rows", node.planRows ?? "—"],
    ["width", node.width ?? "—"],
  ];

  if (node.actualTimeEnd != null) {
    items.push([
      "actual",
      `${node.actualTimeStart ?? 0}..${node.actualTimeEnd} ms`,
    ]);
    items.push(["actual rows", node.actualRows ?? "—"]);
    items.push(["loops", node.loops ?? "—"]);
  }

  metrics.innerHTML = items
    .map(
      ([k, v]) =>
        `<span class="metric"><span class="label">${k}</span> ${v}</span>`
    )
    .join("");

  article.append(title, metrics);

  if (node.details?.length) {
    const ul = document.createElement("ul");
    ul.className = "plan-node__details";
    node.details.forEach((d) => {
      const li = document.createElement("li");
      li.className = "body secondary";
      li.textContent = d;
      ul.appendChild(li);
    });
    article.appendChild(ul);
  }

  const childWrap = document.createElement("div");
  childWrap.className = "plan-node__children";
  (node.children || []).forEach((child) => {
    childWrap.appendChild(renderNode(child, depth + 1));
  });
  article.appendChild(childWrap);

  return article;
}

function renderSummary(meta, format) {
  summaryEl.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item card">
        <p class="label">формат</p>
        <p class="body">${format}</p>
      </div>
      <div class="summary-item card">
        <p class="label">planning time</p>
        <p class="body">${formatMs(meta.planningTimeMs)}</p>
      </div>
      <div class="summary-item card">
        <p class="label">execution time</p>
        <p class="body">${formatMs(meta.executionTimeMs)}</p>
      </div>
    </div>
  `;
}

function renderInsights(insights) {
  insightsEl.innerHTML = "";
  if (!insights.length) {
    insightsEl.hidden = true;
    return;
  }
  insightsEl.hidden = false;
  const list = document.createElement("ul");
  list.className = "insights";
  insights.forEach((item) => {
    const li = document.createElement("li");
    li.className = `insight insight--${item.level}`;
    li.textContent = item.text;
    list.appendChild(li);
  });
  insightsEl.appendChild(list);
}

function render() {
  const result = parseExplain(inputEl.value);

  if (result.error) {
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    summaryEl.innerHTML = "";
    insightsEl.hidden = true;
    treeEl.innerHTML = "";
    formatEl.textContent = "";
    return;
  }

  errorEl.hidden = true;
  formatEl.textContent = result.format === "json" ? "JSON" : "TEXT";
  renderSummary(result.meta, result.format);
  renderInsights(buildInsights(result));
  treeEl.innerHTML = "";
  treeEl.appendChild(renderNode(result.tree));
}

inputEl.addEventListener("input", render);
render();
