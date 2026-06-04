const PLAN_LINE_RE =
  /^(\s*)(?:->\s*)?(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+width=(\d+)\)(?:\s+\(actual time=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+loops=(\d+)\))?/i;

const CTE_LINE_RE = /^(\s*)CTE\s+(\S+)\s*$/i;
const HEADER_PLANNING_RE = /planning\s+time:\s*([\d.]+)\s*ms/i;
const HEADER_EXECUTION_RE = /execution\s+time:\s*([\d.]+)\s*ms/i;

const HEAVY_OPS = [
  "Seq Scan",
  "Parallel Seq Scan",
  "Gather",
  "Sort",
  "Materialize",
  "Nested Loop",
  "Hash Join",
  "Merge Join",
  "Hash",
];

function normalizeLine(line) {
  let s = line;
  if (s.startsWith('"')) s = s.slice(1);
  if (s.endsWith('"')) s = s.slice(0, -1);
  return s;
}

function lineDepth(line) {
  const normalized = line.replace(/\t/g, "  ");
  const indent = normalized.match(/^(\s*)/)[1].length;
  return Math.max(0, Math.floor(indent / 2));
}

function parsePlanLine(match) {
  const title = match[2].trim();
  return {
    title,
    nodeType: extractNodeType(title),
    costStart: parseFloat(match[3]),
    costEnd: parseFloat(match[4]),
    planRows: parseInt(match[5], 10),
    width: parseInt(match[6], 10),
    actualTimeStart: match[7] != null ? parseFloat(match[7]) : null,
    actualTimeEnd: match[8] != null ? parseFloat(match[8]) : null,
    actualRows: match[9] != null ? parseInt(match[9], 10) : null,
    loops: match[10] != null ? parseInt(match[10], 10) : null,
    details: [],
    children: [],
    isCte: false,
  };
}

function extractNodeType(title) {
  for (const op of HEAVY_OPS) {
    if (title.startsWith(op)) return op;
  }
  if (title.startsWith("Index Scan")) return "Index Scan";
  if (title.startsWith("CTE Scan")) return "CTE Scan";
  if (title.startsWith("Append")) return "Append";
  return title.split(/\s+on\s+/)[0].split(/\s+/).slice(0, 2).join(" ");
}

function parseTextExplain(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const meta = { planningTimeMs: null, executionTimeMs: null };
  const root = { title: "QUERY PLAN", children: [], details: [], isCte: false };
  const stack = [{ depth: -1, node: root }];

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;

    const planning = trimmed.match(HEADER_PLANNING_RE);
    if (planning) {
      meta.planningTimeMs = parseFloat(planning[1]);
      continue;
    }
    const execution = trimmed.match(HEADER_EXECUTION_RE);
    if (execution) {
      meta.executionTimeMs = parseFloat(execution[1]);
      continue;
    }

    const cteMatch = line.match(CTE_LINE_RE);
    if (cteMatch) {
      const depth = lineDepth(line);
      const node = {
        title: `CTE ${cteMatch[2]}`,
        nodeType: "CTE",
        isCte: true,
        costStart: null,
        costEnd: null,
        planRows: null,
        width: null,
        actualTimeStart: null,
        actualTimeEnd: null,
        actualRows: null,
        loops: null,
        details: [],
        children: [],
      };
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, node });
      continue;
    }

    const planMatch = line.match(PLAN_LINE_RE);
    if (planMatch) {
      const depth = lineDepth(line);
      const node = parsePlanLine(planMatch);
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, node });
      continue;
    }

    if (stack.length > 1) {
      stack[stack.length - 1].node.details.push(trimmed);
    } else {
      root.details.push(trimmed);
    }
  }

  const topNodes = root.children;
  const tree =
    topNodes.length === 1
      ? topNodes[0]
      : {
          title: "QUERY PLAN",
          nodeType: "Plan",
          children: topNodes,
          details: root.details,
          isCte: false,
          costStart: null,
          costEnd: null,
          planRows: null,
          width: null,
        };

  return { format: "text", meta, tree };
}

function jsonPlanToNode(plan) {
  const parts = [plan["Node Type"]];
  if (plan["Relation Name"]) {
    parts.push(`on ${plan["Relation Name"]}`);
  } else if (plan["Index Name"]) {
    parts.push(`using ${plan["Index Name"]}`);
  }
  if (plan["Alias"]) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${plan.Alias}`;
  }
  const title = parts.join(" ");

  const node = {
    title: title.trim() || plan["Node Type"] || "Plan",
    nodeType: plan["Node Type"] || "Plan",
    costStart: plan["Startup Cost"],
    costEnd: plan["Total Cost"],
    planRows: plan["Plan Rows"],
    width: plan["Plan Width"],
    actualTimeStart: plan["Actual Startup Time"] ?? null,
    actualTimeEnd: plan["Actual Total Time"] ?? null,
    actualRows: plan["Actual Rows"] ?? null,
    loops: plan["Actual Loops"] ?? null,
    details: [],
    children: [],
    isCte: false,
  };

  const skip = new Set([
    "Node Type",
    "Parent Relationship",
    "Relation Name",
    "Schema",
    "Alias",
    "Index Name",
    "Startup Cost",
    "Total Cost",
    "Plan Rows",
    "Plan Width",
    "Actual Startup Time",
    "Actual Total Time",
    "Actual Rows",
    "Actual Loops",
    "Plans",
    "Workers",
    "Workers Planned",
  ]);

  for (const [key, value] of Object.entries(plan)) {
    if (skip.has(key) || value == null || value === "") continue;
    if (typeof value === "object") continue;
    node.details.push(`${key}: ${value}`);
  }

  node.children = (plan.Plans || []).map(jsonPlanToNode);
  return node;
}

function parseJsonExplain(raw) {
  const data = JSON.parse(raw);
  const block = Array.isArray(data) ? data[0] : data;
  const meta = {
    planningTimeMs: block["Planning Time"] ?? block.planning_time ?? null,
    executionTimeMs: block["Execution Time"] ?? block.execution_time ?? null,
  };
  const plan = block.Plan || block.plan;
  if (!plan) {
    throw new Error("В JSON нет поля Plan");
  }
  return { format: "json", meta, tree: jsonPlanToNode(plan) };
}

function detectFormat(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return "json";
  }
  return "text";
}

function parseExplain(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "Вставьте вывод EXPLAIN" };
  }

  try {
    const parsed =
      detectFormat(trimmed) === "json"
        ? parseJsonExplain(trimmed)
        : parseTextExplain(trimmed);
    const analysis = analyzeTree(parsed.tree);
    return { ok: true, ...parsed, analysis };
  } catch (e) {
    return { error: e.message || "Не удалось разобрать" };
  }
}

function collectNodes(node, list = []) {
  if (node.costEnd != null || node.planRows != null || node.isCte) {
    list.push(node);
  }
  for (const child of node.children || []) {
    collectNodes(child, list);
  }
  return list;
}

function formatCompact(n) {
  if (n == null) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function analyzeTree(tree) {
  const nodes = collectNodes(tree).filter((n) => n.costEnd != null);
  const maxCost = Math.max(...nodes.map((n) => n.costEnd || 0), 1);
  const maxRows = Math.max(...nodes.map((n) => n.planRows || 0), 1);

  for (const n of nodes) {
    const costRatio = (n.costEnd || 0) / maxCost;
    const rowsRatio = (n.planRows || 0) / maxRows;
    const issues = [];

    let severity = "ok";

    if (costRatio >= 0.35 || n.costEnd >= 1e8) {
      severity = "critical";
      issues.push("очень высокий cost");
    } else if (costRatio >= 0.12) {
      severity = "warn";
      issues.push("высокий cost");
    }

    if (n.planRows >= 1e9) {
      severity = "critical";
      issues.push("миллиарды строк");
    } else if (n.planRows >= 1e7) {
      severity = severity === "critical" ? "critical" : "warn";
      issues.push("очень много строк");
    }

    if (
      HEAVY_OPS.some((op) => n.title.startsWith(op)) &&
      rowsRatio >= 0.2 &&
      n.planRows >= 1e5
    ) {
      if (severity === "ok") severity = "warn";
      issues.push("тяжёлый оператор + много строк");
    }

    if (
      n.actualRows != null &&
      n.planRows > 0 &&
      n.actualRows > n.planRows * 10
    ) {
      severity = severity === "ok" ? "warn" : severity;
      issues.push("расхождение estimate vs actual");
    }

    if (n.actualTimeEnd != null && n.actualTimeEnd >= 100) {
      issues.push(`медленно: ${n.actualTimeEnd} ms`);
      if (severity === "ok") severity = "warn";
    }

    n.severity = severity;
    n.costRatio = costRatio;
    n.rowsRatio = rowsRatio;
    n.issues = issues;
  }

  const hotspots = [...nodes]
    .sort((a, b) => (b.costEnd || 0) - (a.costEnd || 0))
    .slice(0, 10);

  const criticalCount = nodes.filter((n) => n.severity === "critical").length;
  const warnCount = nodes.filter((n) => n.severity === "warn").length;

  return {
    maxCost,
    maxRows,
    hotspots,
    criticalCount,
    warnCount,
    totalNodes: nodes.length,
  };
}

function buildInsights(result) {
  if (!result.ok) return [];

  const { analysis, tree } = result;
  const insights = [];

  if (analysis.criticalCount) {
    insights.push({
      level: "critical",
      text: `${analysis.criticalCount} узлов с критичной нагрузкой (cost/строки)`,
    });
  }
  if (analysis.warnCount) {
    insights.push({
      level: "warn",
      text: `${analysis.warnCount} узлов требуют внимания`,
    });
  }

  if (analysis.hotspots[0]) {
    const h = analysis.hotspots[0];
    insights.push({
      level: "critical",
      text: `Пик cost: ${h.title} — ${formatCompact(h.costEnd)} (rows ${formatCompact(h.planRows)})`,
    });
  }

  const hugeRows = collectNodes(tree).filter((n) => n.planRows >= 1e9);
  if (hugeRows.length) {
    insights.push({
      level: "critical",
      text: `Оценка >1 млрд строк: ${hugeRows.length} шаг(ов) — риск переполнения/спила`,
    });
  }

  const byTime = collectNodes(tree)
    .filter((n) => n.actualTimeEnd != null)
    .sort((a, b) => b.actualTimeEnd - a.actualTimeEnd);
  if (byTime.length) {
    insights.push({
      level: "info",
      text: `Самый долгий (actual): ${byTime[0].title} — ${byTime[0].actualTimeEnd} ms`,
    });
  }

  return insights;
}
