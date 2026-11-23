// YouTube: сделки и выручка (Маркетинг → YouTube → Сделки и выручка), таблицы yt_leads и yt_paid (schema38/39.sql, collector/youtube.py).
// YouTube-сделка — «Источник» = YouTube или SHORTS Youtube, либо utm_source / utm_medium содержит youtube; создана с 26.07.2025.
// Только действующие Первая (8733326) и Вторая (9701010) линии. Архив и остальные воронки не учитываются.
//   лиды            — YouTube-сделки по месяцу создания;
//   встречи         — из них Первая линия в «Встреча проведена» (142), по месяцу закрытия;
//   чеки            — YouTube-сделки Второй линии, по дате первого входа в «Клиент прислал чек»;
//   оплаты прямые   — YouTube-сделки Второй линии в «100% оплаты получено» (142), по месяцу закрытия, выручка = бюджет сделки;
//   через контакт   — любые оплаченные сделки Второй линии, у контакта которых есть хоть одна YouTube-сделка (прямые входят сюда же);
//                     кампания и выпуск — от самой ранней YouTube-сделки контакта.
//   GET /api/youtube[?from=YYYY-MM&to=YYYY-MM] — по месяцам и годам, по кампаниям, по выпускам
//   GET /api/youtube?detail=leads|meetings|receipts|paid|cpaid&table=month|year|camp|cont|total&key=…[&from&to]
// Раздел закрыт по умолчанию (выручка): marketing.youtube.deals.

import { json, bad, canRead, canView } from "./_lib.js";

const SECTION = "marketing.youtube.deals";
const AMO = "https://pavelgitelman.amocrm.ru";
const MSK = 3 * 3600;
const month = (ts) => (ts ? new Date((Number(ts) + MSK) * 1000).toISOString().slice(0, 7) : "");
const day = (ts) => (ts ? new Date((Number(ts) + MSK) * 1000).toISOString().slice(0, 10) : "");
const NO_UTM = "без UTM";
const DETAIL = ["leads", "meetings", "receipts", "paid", "cpaid"];
const LIMIT = 1000;
const LEAD_PIPELINES = [8733326, 9701010];
const PAID_PIPELINES = [9701010];

function campaign(r) {
  if (!r.utm_source && !r.utm_medium && !r.utm_campaign) return NO_UTM;
  return r.utm_campaign || "(кампания не указана)";
}
const content = (r) => r.utm_content || "без выпуска";
const blank = () => ({ leads: 0, meetings: 0, receipts: 0, paid: 0, revenue: 0, cpaid: 0, crevenue: 0 });
const how = (r) => (r.src === "utm_source" || r.src === "utm_medium" ? r.src + " = " + (r[r.src] || "youtube") : "Источник = " + r.src);
const deal = (r) => ({ id: r.id, url: `${AMO}/leads/detail/${r.id}`, name: r.name || "", created: day(r.created_at), closed: day(r.closed_at),
  stage: r.stage || "", price: Number(r.price) || 0, how: how(r), campaign: campaign(r), content: r.utm_content || "",
  contact: r.contact_id ? { id: r.contact_id, url: `${AMO}/contacts/detail/${r.contact_id}`, name: r.contact_name || "" } : null });

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, SECTION)) return bad("нет доступа к разделу «YouTube · Сделки и выручка»", 403);
  const u = new URL(request.url);
  const from = /^\d{4}-\d{2}$/.test(u.searchParams.get("from") || "") ? u.searchParams.get("from") : "";
  const to = /^\d{4}-\d{2}$/.test(u.searchParams.get("to") || "") ? u.searchParams.get("to") : "";
  const inP = (m) => !!m && (!from || m >= from) && (!to || m <= to);
  // запрос списка: какая ячейка (таблица, строка, показатель)
  const want = DETAIL.includes(u.searchParams.get("detail")) ? { metric: u.searchParams.get("detail"), table: u.searchParams.get("table") || "total", key: u.searchParams.get("key") || "" } : null;
  const items = [];
  const hit = (table, key, metric) => {
    if (!want || want.metric !== metric) return false;
    if (want.table === "year") return table === "month" && key.slice(0, 4) === want.key;
    return want.table === "total" ? table === "month" : want.table === table && want.key === key;
  };

  // SELECT *: страница не падает, пока миграция 39 (названия) не применена
  // Отбираем до группировок и first: сделка из реанимации/архива не может ни увеличить
  // показатель, ни связать оплату через контакт, ни подменить её кампанию/выпуск.
  const leads = (await env.DB.prepare("SELECT * FROM yt_leads WHERE pipeline_id IN (?,?)").bind(...LEAD_PIPELINES).all()).results || [];
  const paidAll = (await env.DB.prepare("SELECT * FROM yt_paid WHERE pipeline_id IN (?)").bind(...PAID_PIPELINES).all()).results || [];
  const receiptSnapshot = await env.OKK_KV.get("youtube:receipt-dates");
  const receiptDates = receiptSnapshot ? JSON.parse(receiptSnapshot) : {};
  const run = await env.DB.prepare("SELECT finished, note FROM runs WHERE collector = 'amo-youtube' ORDER BY finished DESC LIMIT 1").first();

  const T = { month: {}, camp: {}, cont: {} }, srcOf = {}, months = new Set();
  const add = (table, k, f, v, item) => {
    (T[table][k] = T[table][k] || blank())[f] += v;
    if (item && hit(table, k, f) && items.length < LIMIT) items.push(item());
  };
  // самая ранняя YouTube-сделка контакта — от неё кампания и выпуск для оплат через контакт
  const first = {};
  for (const r of leads) {
    const c = r.contact_id;
    if (c && (!first[c] || r.created_at < first[c].created_at)) first[c] = r;
    const ck = campaign(r);
    if (r.utm_source) (srcOf[ck] = srcOf[ck] || new Set()).add(String(r.utm_source).toLowerCase());
    const keys = [["month", null], ["camp", ck], ["cont", content(r)]];
    const mc = month(r.created_at);
    months.add(mc);
    const it = () => deal(r);
    if (inP(mc)) for (const [t, k] of keys) add(t, k || mc, "leads", 1, it);
    const mx = month(r.closed_at || r.created_at);
    if (r.meeting || r.paid) months.add(mx);
    if (r.meeting && inP(mx)) for (const [t, k] of keys) add(t, k || mx, "meetings", 1, it);
    const receiptAt = r.pipeline_id === PAID_PIPELINES[0] ? receiptDates[r.id] : null;
    if (receiptAt) {
      const mr = month(receiptAt);
      months.add(mr);
      if (inP(mr)) for (const [t, k] of keys) {
        add(t, k || mr, "receipts", 1, () => ({ ...deal(r), receipt: day(receiptAt) }));
      }
    }
    if (r.paid && inP(mx)) for (const [t, k] of keys) { add(t, k || mx, "paid", 1, it); add(t, k || mx, "revenue", Number(r.price) || 0); }
  }
  const ytIds = new Set(leads.map((r) => r.id));
  for (const p of paidAll) {
    const f = p.contact_id && first[p.contact_id];
    const mx = month(p.closed_at || p.created_at);
    if (!f) continue;
    months.add(mx);
    if (!inP(mx)) continue;
    const it = () => ({ paid: { id: p.id, url: `${AMO}/leads/detail/${p.id}`, name: p.name || "", closed: day(p.closed_at), price: Number(p.price) || 0 },
      contact: { id: p.contact_id, url: `${AMO}/contacts/detail/${p.contact_id}`, name: p.contact_name || f.contact_name || "" },
      direct: ytIds.has(p.id), via: deal(f) });
    for (const [t, k] of [["month", mx], ["camp", campaign(f)], ["cont", content(f)]]) { add(t, k, "cpaid", 1, it); add(t, k, "crevenue", Number(p.price) || 0); }
  }
  if (want) {
    const sortKey = (x) => (x.paid?.closed || x.receipt || (want.metric === "leads" ? x.created : x.closed)) || "";
    items.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
    return json({ ok: true, ...want, from, to, items, truncated: items.length >= LIMIT });
  }
  const total = blank();
  const years = {};
  for (const [m, r] of Object.entries(T.month)) {
    const year = m.slice(0, 4);
    const row = years[year] ||= blank();
    for (const k in total) {
      row[k] += r[k];
      total[k] += r[k];
    }
  }
  const list = (map, extra) => Object.entries(map).map(([key, r]) => ({ key, ...r, ...(extra ? extra(key) : {}) }))
    .sort((a, b) => b.leads - a.leads || b.crevenue - a.crevenue);
  return json({
    ok: true, from, to,
    months: [...months].filter(Boolean).sort().reverse(),
    updated: run ? run.finished : "", note: run ? run.note : "",
    rows: Object.entries(T.month).map(([m, r]) => ({ month: m, ...r })).sort((a, b) => (a.month < b.month ? 1 : -1)),
    years: Object.entries(years).map(([year, r]) => ({ year, ...r })).sort((a, b) => b.year.localeCompare(a.year)),
    receipts_ready: receiptSnapshot != null,
    total,
    campaigns: list(T.camp, (k) => ({ sources: [...(srcOf[k] || [])].sort() })),
    contents: list(T.cont),
  });
}
