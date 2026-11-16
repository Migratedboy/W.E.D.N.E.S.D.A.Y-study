// ============================================================
// Minimal in-memory stand-in for Supabase (PostgREST + Storage)
// ============================================================
// Implements just enough of the query surface that @supabase/supabase-js uses
// for this app: select, eq/neq/gt/gte/lt/lte/in/is/ilike, order, limit,
// insert, upsert (merge-duplicates), update (PATCH) and delete.
//
// Tests only. Never point this at production data.

import { createServer } from "node:http";

const FILTER_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "ilike", "like"]);

function parseQuery(searchParams) {
  const filters = [];
  let select = "*";
  let order = null;
  let limit = null;
  let offset = null;
  for (const [key, rawValue] of searchParams.entries()) {
    const value = rawValue;
    if (key === "select") { select = value; continue; }
    if (key === "order") {
      const [column, dir] = value.split(".");
      order = { column, ascending: dir !== "desc" };
      continue;
    }
    if (key === "limit") { limit = Number(value); continue; }
    if (key === "offset") { offset = Number(value); continue; }
    const dot = value.indexOf(".");
    if (dot === -1) continue;
    const op = value.slice(0, dot);
    const operand = value.slice(dot + 1);
    if (!FILTER_OPS.has(op)) continue;
    filters.push({ column: key, op, operand });
  }
  return { select, filters, order, limit, offset };
}

function matches(row, filter) {
  const value = row[filter.column];
  const { op, operand } = filter;
  switch (op) {
    case "eq": return String(value) === operand || (value === null && operand === "null");
    case "neq": return String(value) !== operand;
    case "gt": return value > operand;
    case "gte": return value >= operand;
    case "lt": return value < operand;
    case "lte": return value <= operand;
    case "is": return operand === "null" ? (value === null || value === undefined) : String(value) === operand;
    case "in": return operand.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")).includes(String(value));
    case "ilike": return String(value ?? "").toLowerCase() === operand.toLowerCase();
    case "like": return String(value ?? "") === operand;
    default: return true;
  }
}

function project(row, select) {
  if (!select || select === "*") return { ...row };
  const cols = select.split(",").map((c) => c.trim()).filter(Boolean);
  const out = {};
  for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

export function createMockSupabase() {
  /** @type {Record<string, any[]>} */
  const tables = {};
  const storage = new Map();
  const log = [];

  const table = (name) => (tables[name] ||= []);

  function collection(name) {
    const parsed = name.split("?"); // not used; kept for clarity
    return parsed[0];
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    log.push(req.method + " " + url.pathname + url.search);

    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    let raw = "";
    for await (const chunk of req) raw += chunk;
    let payload = null;
    if (raw) { try { payload = JSON.parse(raw); } catch { payload = null; } }

    // ---- Storage emulation ----
    if (url.pathname.startsWith("/storage/v1/")) {
      if (req.method === "POST") {
        const key = url.pathname;
        storage.set(key, raw);
        return send(200, { Key: key });
      }
      if (req.method === "DELETE") { storage.clear(); return send(200, {}); }
      return send(200, { publicUrl: "https://mock.supabase.co/storage/v1/object/public" + url.pathname });
    }

    const restIdx = url.pathname.indexOf("/rest/v1/");
    if (restIdx === -1) return send(404, { message: "not found" });
    const name = url.pathname.slice(restIdx + "/rest/v1/".length);
    const { select, filters, order, limit, offset } = parseQuery(url.searchParams);
    const rows = table(collection(name));
    const prefer = String(req.headers.prefer || "");

    const applyFilters = (list) => list.filter((row) => filters.every((f) => matches(row, f)));

    // ---- GET / HEAD ----
    if (req.method === "GET" || req.method === "HEAD") {
      const headOnly = req.method === "HEAD";
      let result = applyFilters(rows);
      if (order) {
        const { column, ascending } = order;
        result = [...result].sort((a, b) => {
          const av = a[column], bv = b[column];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return ascending ? cmp : -cmp;
        });
      }
      const total = result.length;
      if (offset) result = result.slice(offset);
      if (limit !== null) result = result.slice(0, limit);
      const projected = result.map((r) => project(r, select));
      const headers = {};
      if (String(prefer).includes("count=exact")) headers["content-range"] = "0-" + Math.max(0, total - 1) + "/" + total;
      if (headOnly) {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      // maybeSingle() asks for a single object and treats 0 rows as null.
      if (String(req.headers.accept || "").includes("vnd.pgrst.object")) {
        if (projected.length === 0) return send(406, { code: "PGRST116", message: "no rows" }, headers);
        return send(200, projected[0], headers);
      }
      return send(200, projected, headers);
    }

    // ---- POST (insert or upsert) ----
    // on_conflict is a real header on PostgREST upserts; honouring it matters
    // because `upsert(row, { onConflict: 'user_email' })` must NOT match on email.
    if (req.method === "POST") {
      const incoming = Array.isArray(payload) ? payload : [payload];
      const isUpsert = String(prefer).includes("merge-duplicates");
      const conflictHeader = String(req.headers["on-conflict"] || "").trim();
      const conflictKeys = conflictHeader
        ? conflictHeader.split(",").map((c) => c.trim()).filter(Boolean)
        : null;
      const created = [];
      for (const row of incoming) {
        if (!row) continue;
        let conflict = null;
        if (isUpsert) {
          if (conflictKeys) {
            conflict = rows.find((r) => conflictKeys.every((k) => r[k] !== undefined && r[k] === row[k])) || null;
          } else if (row.id && String(row.id).length < 6 && rows.some((r) => r.id === row.id)) {
            conflict = rows.find((r) => r.id === row.id); // synthetic-id table
          } else if (row.token) {
            conflict = rows.find((r) => r.token === row.token) || null;
          }
        }
        if (conflict) {
          Object.assign(conflict, row);
          created.push(conflict);
        } else {
          const withId = row.id || row.token ? { ...row } : { id: String(rows.length + 1), ...row };
          rows.push(withId);
          created.push(withId);
        }
      }
      return send(201, created.map((r) => project(r, select === "*" ? "*" : select)));
    }

    // ---- PATCH (update) ----
    if (req.method === "PATCH") {
      const targets = applyFilters(rows);
      for (const row of targets) Object.assign(row, payload || {});
      return send(200, String(prefer).includes("return=representation") ? targets : null);
    }

    // ---- DELETE ----
    if (req.method === "DELETE") {
      const removed = applyFilters(rows);
      for (const r of removed) {
        const i = rows.indexOf(r);
        if (i !== -1) rows.splice(i, 1);
      }
      return send(200, []);
    }

    return send(405, { message: "method not allowed" });
  });

  return {
    server,
    tables,
    log,
    seed(name, rows) { table(name).push(...rows); },
    rows: (name) => table(name),
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() { return new Promise((resolve) => server.close(resolve)); }
  };
}
