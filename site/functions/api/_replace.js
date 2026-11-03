// Полная замена набора: валидация всего входа, затем одна транзакционная D1 batch.
// https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
const MAX_ROWS = 20000;
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const int = v => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v));
const ALUMNI = ["file_id", "stream", "company", "person", "niche", "region", "size", "evidence", "problems", "results", "grow", "pct", "changed", "say", "confirmed", "cannot", "when_use", "transition", "takeaway", "question", "ask_alumni"];
const LEADS = ["id", "created_at", "closed_at", "pipeline_id", "status_id", "price", "contact_id", "src", "utm_source", "utm_medium", "utm_campaign", "utm_content", "channel", "meeting", "paid", "name", "contact_name", "stage"];
const PAID = ["id", "contact_id", "pipeline_id", "price", "created_at", "closed_at", "name", "contact_name"];

export function replacementPlan(db, body, stamp) {
  if (body.yt_reset) throw new Error("yt_reset отключён: передайте полный набор в yt_leads_replace.rows");
  if (body.yt_leads_replace && (body.yt_leads?.length || body.yt_drop?.length)) throw new Error("полную замену YouTube нельзя смешивать с изменениями отдельных сделок");
  const statements = [];
  let count = 0;
  for (const [table, input, columns] of [
    ["prep_alumni", body.prep_alumni?.replace ? body.prep_alumni : null, ALUMNI],
    ["yt_paid", body.yt_paid?.replace ? body.yt_paid : null, PAID],
    ["yt_leads", body.yt_leads_replace, LEADS],
  ]) {
    if (!input) continue;
    if (!Array.isArray(input.rows) || input.rows.length > MAX_ROWS) throw new Error(table + ": нужен полный массив rows, не более " + MAX_ROWS + " строк");
    const ids = new Set();
    const rows = input.rows.map((r, index) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(table + ": неверная строка " + index);
      if (table === "prep_alumni") {
        if (!r.say && !r.changed) throw new Error("prep_alumni: строка " + index + " без say/changed");
        return [...columns.map(k => str(r[k], ["say", "changed", "confirmed", "cannot"].includes(k) ? 1500 : 600)), stamp];
      }
      if (!Number.isSafeInteger(Number(r.id)) || Number(r.id) <= 0 || !Number.isSafeInteger(Number(r.created_at)) || Number(r.created_at) <= 0 || ids.has(Number(r.id))) throw new Error(table + ": неверный или повторный id/created_at в строке " + index);
      ids.add(Number(r.id));
      return [...columns.map(k => {
        if (["meeting", "paid"].includes(k)) return r[k] ? 1 : 0;
        if (["id", "created_at", "closed_at", "pipeline_id", "status_id", "price", "contact_id"].includes(k)) return int(r[k]) ?? (["pipeline_id", "status_id", "price"].includes(k) ? 0 : null);
        return str(k === "src" ? r[k] || "YouTube" : r[k], k === "src" ? 40 : ["name", "contact_name", "stage"].includes(k) ? 160 : 120);
      }), stamp];
    });
    const cols = [...columns, "updated_at"];
    const insert = db.prepare("INSERT INTO " + table + " (" + cols.join(",") + ") SELECT " + cols.map((_, i) => "json_extract(value, '$[" + i + "]')").join(",") + " FROM json_each(?)");
    statements.push(db.prepare("DELETE FROM " + table));
    // Каждый JSON-параметр заведомо меньше лимита D1 2 MB, включая кириллицу.
    let chunk = [], bytes = 2;
    const flush = () => { if (chunk.length) statements.push(insert.bind("[" + chunk.join(",") + "]")); chunk = []; bytes = 2; };
    for (const row of rows) {
      const text = JSON.stringify(row), size = new TextEncoder().encode(text).length + 1;
      if (bytes + size > 500000) flush();
      chunk.push(text); bytes += size;
    }
    flush(); count += rows.length;
  }
  return { statements, count };
}
