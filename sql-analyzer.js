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
      tables: extractTablesFromSql(body),
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
  return {
    ok: true,
    ctes,
    mainQuery,
    tables: extractTablesFromSql(mainQuery),
  };
}

function extractTablesFromSql(sql) {
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

function indexPlanByCte(tree) {
  const definitions = new Map();
  const scans = new Map();

  function walk(node) {
    if (node.isCte && node.cteName) {
      definitions.set(normalizeIdent(node.cteName), node);
    }
    if (node.nodeType === "CTE Scan" && node.cteName) {
      const key = normalizeIdent(node.cteName);
      if (!scans.has(key)) scans.set(key, []);
      scans.get(key).push(node);
    }
    for (const child of node.children || []) walk(child);
  }

  walk(tree);
  return { definitions, scans };
}

function buildMainQueryStats(tree, cteDefNodes) {
  const cteNodeSet = new Set();
  for (const node of cteDefNodes) {
    collectPlanNodes(node).forEach((n) => cteNodeSet.add(n));
  }

  const mainNodes = collectPlanNodes(tree).filter((n) => !cteNodeSet.has(n));
  const virtualRoot = { children: mainNodes };
  return subtreeStats(virtualRoot);
}

function buildFragmentAnalytics(tree, sqlText, analysis) {
  const sql = sqlText?.trim() ? parseSqlQuery(sqlText) : { ok: true, ctes: [], mainQuery: "", tables: [] };
  const { definitions, scans } = indexPlanByCte(tree);
  const rootCost = analysis?.maxCost || 1;
  const rootTime =
    collectPlanNodes(tree).reduce((s, n) => s + nodeActualMs(n), 0) || 1;

  const fragments = [];
  const cteDefNodes = [];

  for (const [key, defNode] of definitions) {
    cteDefNodes.push(defNode);
    const sqlCte = sql.ctes.find((c) => c.key === key);
    const bodyNode = defNode.children?.[0] || defNode;
    const stats = subtreeStats(bodyNode);
    const scanNodes = scans.get(key) || [];
    const scanStats = scanNodes.length
      ? {
          maxCost: Math.max(...scanNodes.map((n) => n.costEnd || 0)),
          totalTime: scanNodes.reduce((s, n) => s + nodeActualMs(n), 0),
          chartIds: scanNodes.map((n) => n.chartId).filter(Boolean),
        }
      : { maxCost: 0, totalTime: 0, chartIds: [] };

    fragments.push({
      kind: "cte",
      id: key,
      name: sqlCte?.name || defNode.cteName,
      sql: sqlCte?.body || null,
      preview: sqlCte?.preview || `CTE ${defNode.cteName}`,
      tables: sqlCte?.tables || [],
      definition: stats,
      usage: scanStats,
      cost: stats.maxCost,
      rows: stats.maxRows,
      timeMs: stats.totalTime + scanStats.totalTime,
      chartIds: [...new Set([...stats.chartIds, ...scanStats.chartIds])],
      topNodes: stats.topNodes,
      matchedSql: Boolean(sqlCte),
    });
  }

  for (const sqlCte of sql.ctes) {
    if (definitions.has(sqlCte.key)) continue;
    fragments.push({
      kind: "cte",
      id: sqlCte.key,
      name: sqlCte.name,
      sql: sqlCte.body,
      preview: sqlCte.preview,
      tables: sqlCte.tables,
      definition: null,
      usage: null,
      cost: 0,
      rows: 0,
      timeMs: 0,
      chartIds: [],
      topNodes: [],
      matchedSql: true,
      unmatchedPlan: true,
    });
  }

  const mainStats = buildMainQueryStats(tree, cteDefNodes);
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
  if (sql.ok && sql.ctes.length && !definitions.size) {
    insights.push({
      level: "warn",
      text: "В SQL есть CTE, но в плане нет CTE-узлов — проверьте формат EXPLAIN",
    });
  }

  const heaviest = [...fragments].sort((a, b) => b.cost - a.cost)[0];
  if (heaviest && heaviest.costPct >= 40) {
    insights.push({
      level: heaviest.costPct >= 65 ? "critical" : "warn",
      text: `${heaviest.name} — ~${Math.round(heaviest.costPct)}% cost плана`,
    });
  }

  const unmatchedCtes = fragments.filter((f) => f.unmatchedPlan);
  if (unmatchedCtes.length) {
    insights.push({
      level: "warn",
      text: `${unmatchedCtes.length} CTE из SQL не найдены в плане`,
    });
  }

  return {
    sql,
    fragments,
    tableFragments,
    insights,
    hasSql: Boolean(sqlText?.trim()),
    cteCount: fragments.filter((f) => f.kind === "cte").length,
  };
}
