import http from "http";
import { extractOrderIds, simulateLocalResponse } from "./email-processor.js";

const PORT = Number(process.env.LOCAL_UI_PORT || 8787);
const DB_SCHEMA_PREFERENCE = "Puma_L1_AI";
const DB_TABLES = [
  "orders",
  "email_inbox",
  "cases",
  "case_orders",
  "communications",
  "ai_decisions",
  "risk_events",
  "system_audit_logs",
  "email_queue",
];

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function pickOrderColumn(columns) {
  return [
    "received_at",
    "created_at",
    "updated_at",
    "sent_at",
    "timestamp",
    "case_id",
    "order_id",
  ].find((column) => columns.includes(column));
}

async function fetchDbSnapshot() {
  const { pool } = await import("./db.js");
  const tablesRes = await pool.query(
    `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_name = ANY($1)
    ORDER BY
      CASE WHEN table_schema = $2 THEN 0 ELSE 1 END,
      table_schema,
      table_name
    `,
    [DB_TABLES, DB_SCHEMA_PREFERENCE]
  );

  const seen = new Set();
  const foundTables = [];
  for (const row of tablesRes.rows) {
    if (seen.has(row.table_name)) continue;
    seen.add(row.table_name);
    foundTables.push(row);
  }

  const tables = [];
  for (const table of foundTables) {
    const columnsRes = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [table.table_schema, table.table_name]
    );
    const columns = columnsRes.rows.map((row) => row.column_name);
    const orderColumn = pickOrderColumn(columns);
    const qualifiedName = `${quoteIdent(table.table_schema)}.${quoteIdent(table.table_name)}`;
    const orderClause = orderColumn ? ` ORDER BY ${quoteIdent(orderColumn)} DESC` : "";
    const rowsRes = await pool.query(
      `SELECT * FROM ${qualifiedName}${orderClause} LIMIT 25`
    );
    const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM ${qualifiedName}`);

    tables.push({
      schema: table.table_schema,
      name: table.table_name,
      columns,
      rows: rowsRes.rows,
      count: countRes.rows[0]?.count || 0,
    });
  }

  return {
    connected: true,
    databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
    tables,
    missingTables: DB_TABLES.filter((name) => !seen.has(name)),
  };
}

async function fetchOrderFromDb(orderId) {
  if (!process.env.DATABASE_URL || !orderId) {
    return { attempted: false, orderData: undefined };
  }

  try {
    const { pool } = await import("./db.js");
    const tablesRes = await pool.query(
      `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
        AND table_name = 'orders'
      ORDER BY CASE WHEN table_schema = $1 THEN 0 ELSE 1 END, table_schema
      LIMIT 1
      `,
      [DB_SCHEMA_PREFERENCE]
    );

    const table = tablesRes.rows[0];
    if (!table) return { attempted: true, orderData: null };

    const columnsRes = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [table.table_schema, table.table_name]
    );
    const columns = columnsRes.rows.map((row) => row.column_name);
    const orderColumn = [
      "order_id",
      "id",
      "order_number",
      "order_no",
      "puma_order_id",
    ].find((column) => columns.includes(column));

    if (!orderColumn) return { attempted: true, orderData: null };

    const qualifiedName = `${quoteIdent(table.table_schema)}.${quoteIdent(table.table_name)}`;
    const rowRes = await pool.query(
      `SELECT * FROM ${qualifiedName} WHERE ${quoteIdent(orderColumn)}::text = $1 LIMIT 1`,
      [String(orderId)]
    );

    return { attempted: true, orderData: rowRes.rows[0] || null };
  } catch (error) {
    console.warn("DB order lookup failed:", error.message);
    return { attempted: false, orderData: undefined };
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Puma Reply Tester</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --muted: #666a73;
      --line: #d9dde4;
      --panel: #ffffff;
      --soft: #f5f6f8;
      --accent: #c9002b;
      --accent-ink: #ffffff;
      --focus: #005fcc;
      --good: #107c41;
      --warn: #a15c00;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: #eceff3;
    }

    header {
      min-height: 88px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 22px clamp(18px, 4vw, 48px);
      background: #111111;
      color: #ffffff;
      border-bottom: 4px solid var(--accent);
    }

    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    header p {
      margin: 7px 0 0;
      color: #cfd3da;
      font-size: 14px;
      line-height: 1.45;
    }

    main {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(360px, 1.1fr);
      gap: 18px;
      padding: 18px clamp(14px, 3vw, 32px) 28px;
      max-width: 1480px;
      margin: 0 auto;
    }

    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-width: 0;
      overflow: hidden;
    }

    .db-section {
      grid-column: 1 / -1;
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--soft);
    }

    h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }

    .form {
      display: grid;
      gap: 14px;
      padding: 16px;
    }

    label {
      display: grid;
      gap: 7px;
      font-size: 13px;
      font-weight: 700;
      color: #2f333a;
    }

    input, textarea, select {
      width: 100%;
      border: 1px solid #bfc5cf;
      border-radius: 6px;
      padding: 10px 11px;
      font: inherit;
      color: var(--ink);
      background: #ffffff;
      outline: none;
    }

    textarea {
      min-height: 170px;
      resize: vertical;
      line-height: 1.45;
    }

    input:focus, textarea:focus, select:focus {
      border-color: var(--focus);
      box-shadow: 0 0 0 3px rgba(0, 95, 204, 0.16);
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      min-height: 38px;
      border: 1px solid #aeb5bf;
      border-radius: 6px;
      padding: 8px 12px;
      font: inherit;
      font-weight: 750;
      background: #ffffff;
      color: #1f2329;
      cursor: pointer;
    }

    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-ink);
    }

    button:disabled {
      opacity: 0.58;
      cursor: wait;
    }

    .switches {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .check {
      display: flex;
      align-items: center;
      gap: 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      font-weight: 700;
      background: #fff;
    }

    .check input {
      width: 18px;
      height: 18px;
      margin: 0;
    }

    .meta {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border-bottom: 1px solid var(--line);
      background: #fff;
    }

    .metric {
      padding: 12px 14px;
      border-right: 1px solid var(--line);
      min-width: 0;
    }

    .metric:last-child { border-right: 0; }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .metric strong {
      display: block;
      margin-top: 5px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }

    .reply-wrap {
      padding: 16px;
      display: grid;
      gap: 12px;
    }

    .reply {
      min-height: 360px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      line-height: 1.55;
      overflow: auto;
    }

    pre {
      margin: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #16191f;
      color: #edf2f7;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
      max-height: 260px;
    }

    .status {
      font-size: 13px;
      color: var(--muted);
      min-height: 20px;
    }

    .status.good { color: var(--good); }
    .status.warn { color: var(--warn); }

    .db-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }

    .db-controls select {
      width: min(360px, 100%);
    }

    .db-summary {
      padding: 0 16px 14px;
      color: var(--muted);
      font-size: 13px;
    }

    .table-wrap {
      max-height: 430px;
      overflow: auto;
      border-top: 1px solid var(--line);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      background: #fff;
    }

    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      max-width: 340px;
      overflow-wrap: anywhere;
    }

    th {
      position: sticky;
      top: 0;
      background: #f1f3f6;
      z-index: 1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    td code {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }

    @media (max-width: 940px) {
      header { align-items: flex-start; flex-direction: column; }
      main { grid-template-columns: 1fr; }
      .meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid-2, .switches { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Puma Reply Tester</h1>
      <p>Local harness for the email processor. No Graph inbox polling, no send, no draft creation.</p>
    </div>
    <div class="toolbar">
      <button id="refundPreset">Refund Preset</button>
      <button id="statusPreset">Status Preset</button>
      <button id="clearBtn">Clear</button>
    </div>
  </header>

  <main>
    <section>
      <div class="section-head">
        <h2>Test Input</h2>
        <button class="primary" id="runBtn">Generate Reply</button>
      </div>
      <div class="form">
        <label>
          Subject
          <input id="subject" value="Refund not received" autocomplete="off">
        </label>

        <label>
          Customer Email Body
          <textarea id="body">Hi Puma team,

I returned my shoes but still have not received the refund. Please check order 123456.</textarea>
        </label>

        <div class="grid-2">
          <label>
            From Email
            <input id="fromEmail" value="customer@example.com" autocomplete="off">
          </label>
          <label>
            Intent Override
            <select id="intent">
              <option value="">Auto detect</option>
              <option value="order_status">order_status</option>
              <option value="refund_not_received" selected>refund_not_received</option>
              <option value="cancellation_request">cancellation_request</option>
              <option value="address_change_request">address_change_request</option>
              <option value="return_exchange_request">return_exchange_request</option>
              <option value="invoice_request">invoice_request</option>
              <option value="report_problem">report_problem</option>
              <option value="payment_issue">payment_issue</option>
              <option value="delivery_issue">delivery_issue</option>
              <option value="general_inquiry">general_inquiry</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
        </div>

        <div class="grid-2">
          <label>
            Order ID Override
            <input id="orderId" placeholder="optional">
          </label>
          <label>
            Confidence
            <input id="confidence" type="number" min="0" max="1" step="0.01" value="0.95">
          </label>
        </div>

        <div class="switches">
          <label class="check"><input id="useLLM" type="checkbox" checked> Use LLM rewrite</label>
          <label class="check"><input id="risk" type="checkbox"> Force risk escalation</label>
        </div>

        <div class="status" id="status">Ready.</div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Generated Response</h2>
        <div class="toolbar">
          <button id="copyHtml">Copy HTML</button>
          <button id="copyText">Copy Text</button>
        </div>
      </div>
      <div class="meta">
        <div class="metric"><span>Intent</span><strong id="mIntent">-</strong></div>
        <div class="metric"><span>Decision</span><strong id="mDecision">-</strong></div>
        <div class="metric"><span>Orders</span><strong id="mOrders">-</strong></div>
        <div class="metric"><span>Mode</span><strong id="mMode">-</strong></div>
      </div>
      <div class="reply-wrap">
        <div class="reply" id="reply"></div>
        <pre id="json">{}</pre>
      </div>
    </section>

    <section class="db-section">
      <div class="section-head">
        <h2>Database</h2>
        <button id="refreshDb">Refresh DB</button>
      </div>
      <div class="db-controls">
        <label>
          Table
          <select id="dbTable"></select>
        </label>
        <div class="status" id="dbStatus">Loading database snapshot...</div>
      </div>
      <div class="db-summary" id="dbSummary"></div>
      <div class="table-wrap" id="dbRows"></div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    let lastReplyHtml = "";
    let dbSnapshot = null;

    function setPreset(kind) {
      if (kind === "refund") {
        $("subject").value = "Refund not received";
        $("body").value = "Hi Puma team,\\n\\nI returned my shoes but still have not received the refund. Please check order 123456.";
        $("intent").value = "refund_not_received";
        $("orderId").value = "";
      } else {
        $("subject").value = "Where is my order?";
        $("body").value = "Hello, please tell me the current status for order 123456.";
        $("intent").value = "order_status";
        $("orderId").value = "";
      }
    }

    async function run() {
      $("runBtn").disabled = true;
      $("status").className = "status";
      $("status").textContent = "Generating...";

      try {
        const payload = {
          subject: $("subject").value,
          bodyText: $("body").value,
          fromEmail: $("fromEmail").value,
          intent: $("intent").value,
          confidence: Number($("confidence").value || 0.95),
          risk: $("risk").checked,
          orderId: $("orderId").value,
          useLLMReply: $("useLLM").checked
        };

        const res = await fetch("/api/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Simulation failed");

        lastReplyHtml = data.replyBody || "";
        $("reply").innerHTML = lastReplyHtml || "<em>No reply generated.</em>";
        $("json").textContent = JSON.stringify(data, null, 2);
        $("mIntent").textContent = data.intent + " (" + Number(data.confidence || 0).toFixed(2) + ")";
        $("mDecision").textContent = (data.decision?.status || "-") + " / " + (data.decision?.owner || "-");
        $("mOrders").textContent = data.orderIds?.length ? data.orderIds.join(", ") : "-";
        $("mMode").textContent = data.usedLLMReply ? "LLM" : "Template";
        $("status").className = "status good";
        $("status").textContent = "Generated locally. Nothing was sent.";
      } catch (error) {
        $("status").className = "status warn";
        $("status").textContent = error.message;
      } finally {
        $("runBtn").disabled = false;
      }
    }

    function formatCell(value) {
      if (value === null || value === undefined) return "";
      if (typeof value === "object") return JSON.stringify(value, null, 2);
      return String(value);
    }

    function renderDbTable() {
      const tableName = $("dbTable").value;
      const table = dbSnapshot?.tables?.find((item) => item.name === tableName);
      if (!table) {
        $("dbSummary").textContent = "";
        $("dbRows").innerHTML = "<div class='db-summary'>No rows to show.</div>";
        return;
      }

      $("dbSummary").textContent = table.schema + "." + table.name + " | " + table.count + " total rows | showing latest " + table.rows.length;
      const columns = table.columns.length ? table.columns : Object.keys(table.rows[0] || {});
      if (!columns.length) {
        $("dbRows").innerHTML = "<div class='db-summary'>This table has no visible columns.</div>";
        return;
      }

      const head = columns.map((column) => "<th>" + column + "</th>").join("");
      const body = table.rows.map((row) => {
        const cells = columns.map((column) => "<td><code>" + escapeHtml(formatCell(row[column])) + "</code></td>").join("");
        return "<tr>" + cells + "</tr>";
      }).join("");

      $("dbRows").innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    async function refreshDb() {
      $("refreshDb").disabled = true;
      $("dbStatus").className = "status";
      $("dbStatus").textContent = "Loading database snapshot...";

      try {
        const res = await fetch("/api/db");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load database");

        dbSnapshot = data;
        $("dbTable").innerHTML = data.tables.map((table) => {
          return "<option value='" + escapeHtml(table.name) + "'>" + escapeHtml(table.schema + "." + table.name + " (" + table.count + ")") + "</option>";
        }).join("");

        if (!data.tables.length) {
          $("dbStatus").className = "status warn";
          $("dbStatus").textContent = "Connected, but no known app tables were found.";
          $("dbRows").innerHTML = "<div class='db-summary'>Known tables checked: " + escapeHtml(data.missingTables.join(", ")) + "</div>";
          return;
        }

        $("dbStatus").className = "status good";
        $("dbStatus").textContent = "Loaded " + data.tables.length + " table(s)." + (data.databaseUrlConfigured ? "" : " DATABASE_URL is not set.");
        renderDbTable();
      } catch (error) {
        $("dbStatus").className = "status warn";
        $("dbStatus").textContent = error.message;
        $("dbSummary").textContent = "Set DATABASE_URL in the same shell before running npm run local-ui to view Railway/Postgres data.";
        $("dbRows").innerHTML = "";
      } finally {
        $("refreshDb").disabled = false;
      }
    }

    $("runBtn").addEventListener("click", run);
    $("refundPreset").addEventListener("click", () => setPreset("refund"));
    $("statusPreset").addEventListener("click", () => setPreset("status"));
    $("clearBtn").addEventListener("click", () => {
      $("subject").value = "";
      $("body").value = "";
      $("orderId").value = "";
      $("reply").innerHTML = "";
      $("json").textContent = "{}";
    });
    $("copyHtml").addEventListener("click", () => navigator.clipboard.writeText(lastReplyHtml));
    $("copyText").addEventListener("click", () => {
      const div = document.createElement("div");
      div.innerHTML = lastReplyHtml;
      navigator.clipboard.writeText(div.innerText);
    });
    $("refreshDb").addEventListener("click", refreshDb);
    $("dbTable").addEventListener("change", renderDbTable);

    run();
    refreshDb();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(pageHtml());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/simulate") {
      const payload = await readJson(req);
      const orderIds = payload.orderId
        ? [String(payload.orderId)]
        : extractOrderIds(`${payload.subject || ""}\n${payload.bodyText || ""}`);
      const dbLookup = await fetchOrderFromDb(orderIds[0]);
      const result = await simulateLocalResponse({
        ...payload,
        trustedOrderData: dbLookup.orderData,
        trustTableOnly: dbLookup.attempted,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/db") {
      const result = await fetchDbSnapshot();
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Puma local reply tester: http://localhost:${PORT}`);
});

