function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      out += quote;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote && sql[i - 1] !== "\\") {
          i++;
          if (sql[i] !== quote) break;
        }
        i++;
      }
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

function readBalancedParen(sql, openIndex) {
  if (sql[openIndex] !== "(") return null;
  let depth = 0;
  for (let i = openIndex; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function normalizeIdent(name) {
  return String(name || "")
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

function parseSqlQuery(sql) {
  const cleaned = stripSqlComments(sql).trim();
  if (!cleaned) {
    return { ok: false, error: null, ctes: [], mainQuery: "", tables: [] };
  }

  if (!/^with\b/i.test(cleaned)) {
    return {
      ok: true,
      ctes: [],
      mainQuery: cleaned,
      tables: extractTablesFromSql(cleaned),
    };
  }

  const afterWith = cleaned.replace(/^with\s+(?:recursive\s+)?/i, "");
  const ctes = [];
  let pos = 0;

  while (pos < afterWith.length) {
    while (pos < afterWith.length && /\s/.test(afterWith[pos])) pos++;

    const nameMatch = afterWith.slice(pos).match(/^("([^"]+)"|([a-zA-Z_][\w$]*))\s+as\s*/i);
    if (!nameMatch) break;

    const name = nameMatch[2] || nameMatch[3];
    pos += nameMatch[0].length;

    while (pos < afterWith.length && /\s/.test(afterWith[pos])) pos++;
    if (afterWith[pos] !== "(") break;

    const close = readBalancedParen(afterWith, pos);
    if (close == null) break;

    const body = afterWith.slice(pos + 1, close).trim();
    ctes.push({
      name,
      key: normalizeIdent(name),
      body,
      preview: body.length > 280 ? `${body.slice(0, 280)}…` : body,
      tables: [],
    });

    pos = close + 1;
    while (pos < afterWith.length && /\s/.test(afterWith[pos])) pos++;
    if (afterWith[pos] === ",") {
      pos++;
      continue;
    }
    break;
  }

  const mainQuery = afterWith.slice(pos).trim().replace(/^,\s*/, "");
  const cteKeys = new Set(ctes.map((c) => c.key));
  for (const cte of ctes) {
    cte.tables = extractTablesFromSql(cte.body, cteKeys);
  }
  return {
    ok: true,
    ctes,
    mainQuery,
    tables: extractTablesFromSql(mainQuery),
  };
}

function extractTablesFromSql(sql, excludeKeys = null) {
  const tables = [];
  const seen = new Set();
  const re =
    /\b(?:from|join)\s+(?:only\s+)?(?:(\w+)\.)?("([^"]+)"|([a-zA-Z_][\w$]*))(?:\s+(?:as\s+)?("([^"]+)"|([a-zA-Z_][\w$]*)))?/gi;

  let match;
  while ((match = re.exec(sql))) {
    const schema = match[1] || null;
    const table = match[3] || match[4];
    const alias = match[6] || match[7] || null;
    const key = normalizeIdent(table);
    if (excludeKeys?.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push({ schema, table, alias, key });
  }
  return tables;
}

function collectPlanNodes(node, list = []) {
  list.push(node);
  for (const child of node.children || []) collectPlanNodes(child, list);
  return list;
}

function nodeActualMs(node) {
  if (node.actualTimeEnd == null) return 0;
  return (node.actualTimeEnd || 0) * (node.loops || 1);
}

function subtreeStats(root) {
  const nodes = collectPlanNodes(root);
  const withCost = nodes.filter((n) => n.costEnd != null);
  const withTime = nodes.filter((n) => nodeActualMs(n) > 0);

  const maxCost = withCost.length
    ? Math.max(...withCost.map((n) => n.costEnd || 0))
    : 0;
  const maxRows = withCost.length
    ? Math.max(...withCost.map((n) => n.planRows || 0))
    : 0;
  const totalTime = withTime.reduce((s, n) => s + nodeActualMs(n), 0);
  const chartIds = nodes.map((n) => n.chartId).filter(Boolean);

  return {
    nodeCount: nodes.length,
    maxCost,
    maxRows,
    totalTime,
    chartIds,
    nodes,
    topNodes: [...withCost]
      .sort((a, b) => (b.costEnd || 0) - (a.costEnd || 0))
      .slice(0, 5),
  };
}

function statsFromNodeList(nodes) {
  const withCost = nodes.filter((n) => n.costEnd != null);
  const withTime = nodes.filter((n) => nodeActualMs(n) > 0);
  const maxCost = withCost.length ? Math.max(...withCost.map((n) => n.costEnd || 0)) : 0;
  const maxRows = withCost.length ? Math.max(...withCost.map((n) => n.planRows || 0)) : 0;
  const totalTime = withTime.reduce((s, n) => s + nodeActualMs(n), 0);

  return {
    nodeCount: nodes.length,
    maxCost,
    maxRows,
    totalTime,
    chartIds: nodes.map((n) => n.chartId).filter(Boolean),
    nodes,
    topNodes: [...withCost]
      .sort((a, b) => (b.costEnd || 0) - (a.costEnd || 0))
      .slice(0, 5),
  };
}

function indexPlanByCte(tree) {
  const definitions = new Map();
  const scans = new Map();
  const subqueryScans = new Map();

  function walk(node) {
    if (node.isCte && node.cteName) {
      definitions.set(normalizeIdent(node.cteName), node);
    }
    if (node.nodeType === "CTE Scan" && node.cteName) {
      const key = normalizeIdent(node.cteName);
      if (!scans.has(key)) scans.set(key, []);
      scans.get(key).push(node);
    }
    const subName = node.subqueryName || node.cteName;
    if (node.nodeType === "Subquery Scan" && subName) {
      const key = normalizeIdent(subName);
      if (!subqueryScans.has(key)) subqueryScans.set(key, []);
      subqueryScans.get(key).push(node);
    }
    for (const child of node.children || []) walk(child);
  }

  walk(tree);
  return { definitions, scans, subqueryScans };
}

function extractCteRefsFromMain(mainQuery, sqlCtes) {
  const cteKeys = new Set(sqlCtes.map((c) => c.key));
  const refs = new Map();
  for (const cte of sqlCtes) {
    refs.set(cte.key, new Set());
  }

  const re =
    /\b(?:from|join)\s+(?:only\s+)?(?:(\w+)\.)?("([^"]+)"|([a-zA-Z_][\w$]*))(?:\s+(?:as\s+)?("([^"]+)"|([a-zA-Z_][\w$]*)))?/gi;

  let match;
  while ((match = re.exec(mainQuery))) {
    const name = normalizeIdent(match[3] || match[4]);
    const alias = normalizeIdent(match[6] || match[7] || "");
    if (cteKeys.has(name)) {
      refs.get(name).add(name);
      if (alias) refs.get(name).add(alias);
    }
  }
  return refs;
}

function addSubtreeToAssignment(assignments, cteKey, node) {
  if (!assignments.has(cteKey)) assignments.set(cteKey, new Set());
  for (const n of collectPlanNodes(node)) {
    assignments.get(cteKey).add(n);
  }
}

function inferCteAssignments(tree, sql) {
  const assignments = new Map();
  const methods = new Map();
  const { definitions, scans, subqueryScans } = indexPlanByCte(tree);
  const allNodes = collectPlanNodes(tree);
  const mainRefs = extractCteRefsFromMain(sql.mainQuery || "", sql.ctes);

  const noteMethod = (key, method) => {
    if (!methods.has(key)) methods.set(key, method);
    else if (methods.get(key) === "inferred_tables" && method !== "inferred_tables") {
      methods.set(key, method);
    }
  };

  for (const [key, defNode] of definitions) {
    if (!sql.ctes.find((c) => c.key === key)) continue;
    addSubtreeToAssignment(assignments, key, defNode.children?.[0] || defNode);
    noteMethod(key, "plan_cte");
  }

  for (const [key, scanNodes] of scans) {
    if (!sql.ctes.find((c) => c.key === key)) continue;
    for (const node of scanNodes) {
      addSubtreeToAssignment(assignments, key, node);
    }
    noteMethod(key, "cte_scan");
  }

  for (const cte of sql.ctes) {
    const aliases = mainRefs.get(cte.key) || new Set([cte.key]);
    for (const alias of aliases) {
      const nodes = subqueryScans.get(alias) || [];
      for (const node of nodes) {
        addSubtreeToAssignment(assignments, cte.key, node);
        noteMethod(cte.key, "subquery_scan");
      }
    }
  }

  const mainTableKeys = new Set(extractTablesFromSql(sql.mainQuery || "").map((t) => t.key));
  const tableToCtes = new Map();

  for (const cte of sql.ctes) {
    for (const table of cte.tables) {
      if (!tableToCtes.has(table.key)) tableToCtes.set(table.key, []);
      tableToCtes.get(table.key).push(cte.key);
    }
  }

  for (const node of allNodes) {
    if (!node.relationName || node.nodeType === "CTE Scan") continue;
    const tableKey = normalizeIdent(node.relationName);
    const owners = tableToCtes.get(tableKey) || [];
    if (owners.length !== 1) continue;
    if (mainTableKeys.has(tableKey)) continue;

    const cteKey = owners[0];
    if (assignments.has(cteKey) && assignments.get(cteKey).has(node)) continue;
    addSubtreeToAssignment(assignments, cteKey, node);
    noteMethod(cteKey, "inferred_tables");
  }

  for (const cte of sql.ctes) {
    if (!assignments.has(cte.key)) {
      assignments.set(cte.key, new Set());
      methods.set(cte.key, "unmatched");
    }
  }

  return { assignments, methods, definitions, scans };
}

function annotateTreeCteAttributions(tree, fragments) {
  for (const node of collectPlanNodes(tree)) {
    node.attributedCtes = [];
  }

  for (const frag of fragments) {
    if (frag.kind !== "cte") continue;
    for (const chartId of frag.chartIds || []) {
      for (const node of collectPlanNodes(tree)) {
        if (node.chartId === chartId && !node.attributedCtes.includes(frag.name)) {
          node.attributedCtes.push(frag.name);
        }
      }
    }
  }
}

function buildMainQueryStats(tree, assignedNodeSets) {
  const assigned = new Set();
  for (const set of assignedNodeSets) {
    for (const node of set) assigned.add(node);
  }

  const mainNodes = collectPlanNodes(tree).filter((n) => !assigned.has(n));
  return statsFromNodeList(mainNodes);
}

function buildFragmentAnalytics(tree, sqlText, analysis) {
  const sql = sqlText?.trim() ? parseSqlQuery(sqlText) : { ok: true, ctes: [], mainQuery: "", tables: [] };
  const { assignments, methods, definitions, scans } = inferCteAssignments(tree, sql);
  const rootCost = analysis?.maxCost || 1;
  const rootTime =
    collectPlanNodes(tree).reduce((s, n) => s + nodeActualMs(n), 0) || 1;

  const fragments = [];
  const assignedSets = [];

  for (const sqlCte of sql.ctes) {
    const key = sqlCte.key;
    const nodeSet = assignments.get(key) || new Set();
    const nodes = [...nodeSet];
    assignedSets.push(nodeSet);

    const defNode = definitions.get(key);
    const stats = nodes.length ? statsFromNodeList(nodes) : null;
    const scanNodes = scans.get(key) || [];
    const scanStats = scanNodes.length
      ? {
          maxCost: Math.max(...scanNodes.map((n) => n.costEnd || 0)),
          totalTime: scanNodes.reduce((s, n) => s + nodeActualMs(n), 0),
          chartIds: scanNodes.map((n) => n.chartId).filter(Boolean),
        }
      : { maxCost: 0, totalTime: 0, chartIds: [] };

    const method = methods.get(key) || "unmatched";
    const matchedPlan = method !== "unmatched" && nodes.length > 0;
    const inferred = method === "inferred_tables" || method === "subquery_scan";

    fragments.push({
      kind: "cte",
      id: key,
      name: sqlCte.name,
      sql: sqlCte.body,
      preview: sqlCte.preview,
      tables: sqlCte.tables,
      definition: stats,
      usage: scanStats,
      cost: stats?.maxCost || scanStats.maxCost || 0,
      rows: stats?.maxRows || 0,
      timeMs: (stats?.totalTime || 0) + scanStats.totalTime,
      chartIds: stats
        ? [...new Set([...stats.chartIds, ...scanStats.chartIds])]
        : [],
      topNodes: stats?.topNodes || [],
      matchedSql: true,
      matchedPlan,
      inferred,
      matchMethod: method,
      unmatchedPlan: !matchedPlan,
      planDefNode: defNode || null,
    });
  }

  for (const [key, defNode] of definitions) {
    if (sql.ctes.find((c) => c.key === key)) continue;
    const bodyNode = defNode.children?.[0] || defNode;
    const stats = subtreeStats(bodyNode);
    const scanNodes = scans.get(key) || [];
    assignedSets.push(new Set(stats.nodes));

    fragments.push({
      kind: "cte",
      id: key,
      name: defNode.cteName,
      sql: null,
      preview: `CTE ${defNode.cteName}`,
      tables: [],
      definition: stats,
      usage: scanNodes.length
        ? {
            maxCost: Math.max(...scanNodes.map((n) => n.costEnd || 0)),
            totalTime: scanNodes.reduce((s, n) => s + nodeActualMs(n), 0),
            chartIds: scanNodes.map((n) => n.chartId).filter(Boolean),
          }
        : null,
      cost: stats.maxCost,
      rows: stats.maxRows,
      timeMs: stats.totalTime,
      chartIds: stats.chartIds,
      topNodes: stats.topNodes,
      matchedSql: false,
      matchedPlan: true,
      inferred: false,
      matchMethod: "plan_cte",
      unmatchedPlan: false,
      planDefNode: defNode,
    });
  }

  const mainStats = buildMainQueryStats(tree, assignedSets);
  fragments.push({
    kind: "main",
    id: "main",
    name: "Основной запрос",
    sql: sql.mainQuery || null,
    preview: sql.mainQuery
      ? sql.mainQuery.length > 320
        ? `${sql.mainQuery.slice(0, 320)}…`
        : sql.mainQuery
      : "Корневой план выполнения",
    tables: sql.tables || [],
    definition: mainStats,
    usage: null,
    cost: mainStats.maxCost,
    rows: mainStats.maxRows,
    timeMs: mainStats.totalTime,
    chartIds: mainStats.chartIds,
    topNodes: mainStats.topNodes,
    matchedSql: Boolean(sql.mainQuery),
    matchedPlan: true,
    inferred: false,
    unmatchedPlan: false,
  });

  const tableFragments = [];
  const tableNodes = collectPlanNodes(tree).filter(
    (n) => n.relationName && n.nodeType !== "CTE Scan"
  );
  const byTable = new Map();

  for (const node of tableNodes) {
    const key = normalizeIdent(node.relationName);
    if (!byTable.has(key)) {
      byTable.set(key, []);
    }
    byTable.get(key).push(node);
  }

  for (const [key, nodes] of byTable) {
    const sqlTable = [...sql.tables, ...sql.ctes.flatMap((c) => c.tables)].find(
      (t) => t.key === key
    );
    const cost = Math.max(...nodes.map((n) => n.costEnd || 0));
    const rows = Math.max(...nodes.map((n) => n.planRows || 0));
    const timeMs = nodes.reduce((s, n) => s + nodeActualMs(n), 0);

    tableFragments.push({
      kind: "table",
      id: key,
      name: sqlTable?.table || nodes[0].relationName,
      alias: sqlTable?.alias || nodes[0].alias,
      schema: sqlTable?.schema || nodes[0].schema,
      scanCount: nodes.length,
      cost,
      rows,
      timeMs,
      chartIds: nodes.map((n) => n.chartId).filter(Boolean),
      topNodes: [...nodes]
        .sort((a, b) => (b.costEnd || 0) - (a.costEnd || 0))
        .slice(0, 3),
    });
  }

  for (const frag of fragments) {
    frag.costPct = rootCost > 0 ? (frag.cost / rootCost) * 100 : 0;
    frag.timePct = rootTime > 0 ? (frag.timeMs / rootTime) * 100 : 0;
  }

  for (const frag of tableFragments) {
    frag.costPct = rootCost > 0 ? (frag.cost / rootCost) * 100 : 0;
    frag.timePct = rootTime > 0 ? (frag.timeMs / rootTime) * 100 : 0;
  }

  fragments.sort((a, b) => {
    if (a.kind === "main") return 1;
    if (b.kind === "main") return -1;
    return b.cost - a.cost;
  });

  tableFragments.sort((a, b) => b.cost - a.cost);

  const insights = [];
  const matchedCtes = fragments.filter((f) => f.kind === "cte" && f.matchedPlan);
  const inferredCtes = fragments.filter((f) => f.kind === "cte" && f.inferred);
  const unmatchedCtes = fragments.filter((f) => f.kind === "cte" && f.unmatchedPlan);

  if (sql.ok && sql.ctes.length && !definitions.size && inferredCtes.length) {
    insights.push({
      level: "info",
      text: `CTE встроены в план (PostgreSQL 12+) — сопоставлено ${inferredCtes.length} из ${sql.ctes.length} по SQL`,
    });
  } else if (sql.ok && sql.ctes.length && !definitions.size && !matchedCtes.length) {
    insights.push({
      level: "warn",
      text: "CTE не удалось сопоставить с планом — добавьте уникальные таблицы в каждый CTE или AS MATERIALIZED",
    });
  }

  const heaviest = [...fragments].sort((a, b) => b.cost - a.cost)[0];
  if (heaviest && heaviest.costPct >= 40 && heaviest.kind !== "main") {
    insights.push({
      level: heaviest.costPct >= 65 ? "critical" : "warn",
      text: `${heaviest.name} — ~${Math.round(heaviest.costPct)}% cost плана`,
    });
  } else if (heaviest?.kind === "main" && heaviest.costPct >= 90 && sql.ctes.length) {
    insights.push({
      level: "info",
      text: "Большая часть cost в основном запросе — CTE могут быть полностью inline",
    });
  }

  if (unmatchedCtes.length) {
    insights.push({
      level: "warn",
      text: `${unmatchedCtes.length} CTE без узлов в плане — проверьте имена и таблицы в теле CTE`,
    });
  }

  annotateTreeCteAttributions(tree, fragments);

  return {
    sql,
    fragments,
    tableFragments,
    insights,
    hasSql: Boolean(sqlText?.trim()),
    cteCount: fragments.filter((f) => f.kind === "cte").length,
    inferredCteCount: inferredCtes.length,
  };
}
