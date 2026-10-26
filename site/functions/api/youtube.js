// YouTube: сделки и выручка (Маркетинг → YouTube → Сделки и выручка), таблицы yt_leads и yt_paid (schema38.sql, collector/youtube.py).
// YouTube-сделка — «Источник» = YouTube или SHORTS Youtube, либо utm_source / utm_medium содержит youtube; создана с 26.07.2025.
//   лиды            — YouTube-сделки по месяцу создания;
//   встречи         — из них Первая линия в «Встреча проведена» (142), по месяцу закрытия;
//   оплаты прямые   — YouTube-сделки Второй линии в «100% оплаты получено» (142), по месяцу закрытия, выручка = бюджет сделки;
//   через контакт   — любые оплаченные сделки Второй линии, у контакта которых есть хоть одна YouTube-сделка (прямые входят сюда же);
//                     кампания и выпуск — от самой ранней YouTube-сделки контакта.
//   GET /api/youtube[?from=YYYY-MM&to=YYYY-MM] — по месяцам, по кампаниям (utm_campaign), по выпускам (utm_content)
// Раздел закрыт по умолчанию (выручка): marketing.youtube.deals.

import { json, bad, canRead, canView } from "./_lib.js";

const SECTION = "marketing.youtube.deals";
const MSK = 3 * 3600;
const month = (ts) => (ts ? new Date((Number(ts) + MSK) * 1000).toISOString().slice(0, 7) : "");
const NO_UTM = "без UTM";

function campaign(r) {
  if (!r.utm_source && !r.utm_medium && !r.utm_campaign) return NO_UTM;
  return r.utm_campaign || "(кампания не указана)";
}
const content = (r) => r.utm_content || "без выпуска";
const blank = () => ({ leads: 0, meetings: 0, paid: 0, revenue: 0, cpaid: 0, crevenue: 0 });

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, SECTION)) return bad("нет доступа к разделу «YouTube · Сделки и выручка»", 403);
  const u = new URL(request.url);
  const from = /^\d{4}-\d{2}$/.test(u.searchParams.get("from") || "") ? u.searchParams.get("from") : "";
  const to = /^\d{4}-\d{2}$/.test(u.searchParams.get("to") || "") ? u.searchParams.get("to") : "";
  const inP = (m) => !!m && (!from || m >= from) && (!to || m <= to);

  const leads = (await env.DB.prepare("SELECT id, created_at, closed_at, price, contact_id, src, utm_source, utm_medium, utm_campaign, utm_content, meeting, paid FROM yt_leads").all()).results || [];
  const paidAll = (await env.DB.prepare("SELECT id, contact_id, price, closed_at, created_at FROM yt_paid").all()).results || [];
  const run = await env.DB.prepare("SELECT finished, note FROM runs WHERE collector = 'amo-youtube' ORDER BY finished DESC LIMIT 1").first();

  const byM = {}, byC = {}, byE = {}, srcOf = {}, months = new Set();
  const add = (map, k, f, v = 1) => { (map[k] = map[k] || blank())[f] += v; };
  // самая ранняя YouTube-сделка контакта — от неё кампания и выпуск для оплат через контакт
  const first = {};
  for (const r of leads) {
    const c = r.contact_id;
    if (c && (!first[c] || r.created_at < first[c].created_at)) first[c] = r;
    const ck = campaign(r);
    if (r.utm_source) (srcOf[ck] = srcOf[ck] || new Set()).add(String(r.utm_source).toLowerCase());
    const mc = month(r.created_at);
    months.add(mc);
    if (inP(mc)) { add(byM, mc, "leads"); add(byC, ck, "leads"); add(byE, content(r), "leads"); }
    const mx = month(r.closed_at || r.created_at);
    if (r.meeting && inP(mx)) { add(byM, mx, "meetings"); add(byC, ck, "meetings"); add(byE, content(r), "meetings"); }
    if (r.paid && inP(mx)) {
      for (const [m, k] of [[byM, mx], [byC, ck], [byE, content(r)]]) { add(m, k, "paid"); add(m, k, "revenue", Number(r.price) || 0); }
    }
  }
  for (const p of paidAll) {
    const f = p.contact_id && first[p.contact_id];
    const mx = month(p.closed_at || p.created_at);
    if (!f || !inP(mx)) continue;
    for (const [m, k] of [[byM, mx], [byC, campaign(f)], [byE, content(f)]]) { add(m, k, "cpaid"); add(m, k, "crevenue", Number(p.price) || 0); }
  }
  const total = blank();
  for (const r of Object.values(byM)) for (const k in total) total[k] += r[k];
  const list = (map, extra) => Object.entries(map).map(([key, r]) => ({ key, ...r, ...(extra ? extra(key) : {}) }))
    .sort((a, b) => b.leads - a.leads || b.crevenue - a.crevenue);
  return json({
    ok: true, from, to,
    months: [...months].filter(Boolean).sort().reverse(),
    updated: run ? run.finished : "", note: run ? run.note : "",
    rows: Object.entries(byM).map(([m, r]) => ({ month: m, ...r })).sort((a, b) => (a.month < b.month ? 1 : -1)),
    total,
    campaigns: list(byC, (k) => ({ sources: [...(srcOf[k] || [])].sort() })),
    contents: list(byE),
  });
}
