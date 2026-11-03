// Единая политика для сырых точек, видов разделов и контекста ИИ.
import { canView, SECTIONS } from "./_lib.js";

const SOURCES = {
  "Инстаграм smm": "marketing.instagram", "Телеграм канал": "marketing.telegram",
  "Интеграции": "marketing.influence", YouTube: "marketing.youtube",
  "Реклама FB": "marketing.fb", GitelmanSiteChat: "marketing.sitechat", "Сайт": "marketing.site",
};

export function metricSections(metric) {
  // Старые обозначения реестра и копии показателей в общей воронке.
  let section = ({ mkt: "marketing", participants: "sales.l2", finance: "budget" })[metric.section] || metric.section;
  if (/^(?:fun\.|cv\.)?l1m?\./.test(metric.id)) section = "sales.l1";
  if (/^(?:fun\.|cv\.)?l2\./.test(metric.id)) section = "sales.l2";
  const sections = [section];
  // Срез воронки не должен становиться обходом запрета самих продаж.
  if (/^seg\.(held|sales)$/.test(metric.id)) sections.push("sales.l2");
  if (/^seg\.(answered|q3|qual|booked)$/.test(metric.id)) sections.push("sales.l1");
  return [...new Set(sections)];
}

export function canReadMetric(user, metric, dim = null) {
  const sections = metricSections(metric);
  if (!sections.every(s => SECTIONS.includes(s))) return false;
  if (user?.role === "service") return true; // canRead допускает службу только на явные GET-маршруты
  return sections.every(section => {
    if (section !== "marketing") return canView(user, section);
    const source = typeof dim === "string" ? dim.replace(/^src:/, "").split("|")[0] : "";
    if (SOURCES[source]) return canView(user, SOURCES[source]);
    // Общий итог/произвольный LIKE содержит все источники, в том числе закрытые.
    return canView(user, "marketing") && Object.values(SOURCES).every(s => canView(user, s));
  });
}

export async function readableMetrics(env, user, dim = null) {
  const rows = await env.DB.prepare("SELECT * FROM metrics ORDER BY section, id").all();
  return (rows.results || []).filter(m => canReadMetric(user, m, dim));
}
