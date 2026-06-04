const PLAN_LINE_RE =
  /^(\s*)(?:->\s*)?(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+width=(\d+)\)(?:\s+\(actual time=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+loops=(\d+)\))?/i;

const HEADER_PLANNING_RE = /planning\s+time:\s*([\d.]+)\s*ms/i;
const HEADER_EXECUTION_RE = /execution\s+time:\s*([\d.]+)\s*ms/i;

function lineDepth(line) {
  const normalized = line.replace(/\t/g, "  ");
  const arrowMatch = normalized.match(/^(\s*)->\s+/);
  if (arrowMatch) {
    return Math.floor(arrowMatch[1].length / 2) + 1;
  }
  const spaces = normalized.match(/^(\s*)/)[1].length;
  return Math.floor(spaces / 4);
}

function parsePlanLine(match) {
  const title = match[2].trim();
  const node = {
    title,
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
  };
  return node;
}

function parseTextExplain(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const meta = { planningTimeMs: null, executionTimeMs: null };
  const root = { title: "QUERY PLAN", children: [], details: [] };
  const stack = [{ depth: -1, node: root }];

  for (const line of lines) {
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
  return {
    format: "text",
    meta,
    tree: topNodes.length === 1 ? topNodes[0] : { title: "QUERY PLAN", children: topNodes, details: root.details },
  };
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

  const children = plan.Plans || [];
  node.children = children.map(jsonPlanToNode);
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
    if (detectFormat(trimmed) === "json") {
      return { ok: true, ...parseJsonExplain(trimmed) };
    }
    return { ok: true, ...parseTextExplain(trimmed) };
  } catch (e) {
    return { error: e.message || "Не удалось разобрать" };
  }
}

function collectNodes(node, list = []) {
  if (node.costEnd != null || node.actualTimeEnd != null) {
    list.push(node);
  }
  for (const child of node.children || []) {
    collectNodes(child, list);
  }
  return list;
}

function buildInsights(result) {
  if (!result.ok) return [];

  const nodes = collectNodes(result.tree);
  const insights = [];

  for (const n of nodes) {
    if (
      n.actualRows != null &&
      n.planRows > 0 &&
      n.actualRows > n.planRows * 10
    ) {
      insights.push({
        level: "warn",
        text: `${n.title}: фактических строк (${n.actualRows}) >> оценки (${n.planRows})`,
      });
    }
    if (n.actualTimeEnd != null && n.actualTimeEnd >= 100) {
      insights.push({
        level: "warn",
        text: `${n.title}: долго — ${n.actualTimeEnd} ms (loops=${n.loops ?? 1})`,
      });
    }
  }

  const byTime = nodes
    .filter((n) => n.actualTimeEnd != null)
    .sort((a, b) => b.actualTimeEnd - a.actualTimeEnd);
  if (byTime.length) {
    const top = byTime[0];
    insights.unshift({
      level: "info",
      text: `Самый долгий шаг: ${top.title} — ${top.actualTimeEnd} ms`,
    });
  }

  return insights;
}
