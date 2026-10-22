// «Чья» подготовка / разбор / пинг (22.10.2026): владелец — тот, кто отправил номер сделки (prep.queued_by).
// Разбор и пинги лежат под копией сделки на Второй линии — её связь с подготовкой берём из debrief_queue (deal → l2).
export async function ownerMaps(env) {
  const by = {}, names = {};
  try {
    const prep = (await env.DB.prepare("SELECT deal, queued_by FROM prep WHERE queued_by IS NOT NULL AND queued_by != ''").all()).results || [];
    for (const r of prep) by[r.deal] = r.queued_by;
  } catch (e) { /* нет таблицы */ }
  try {
    const q = (await env.DB.prepare("SELECT deal, l2 FROM debrief_queue WHERE l2 IS NOT NULL").all()).results || [];
    for (const r of q) if (by[r.deal] && !by[r.l2]) by[r.l2] = by[r.deal];
  } catch (e) { /* нет таблицы */ }
  const users = (await env.DB.prepare("SELECT login, name FROM users").all()).results || [];
  for (const u of users) names[u.login] = String(u.name || u.login).split("|")[0].trim();
  return {
    names,
    tag(row, deal) {
      let l = by[deal != null ? deal : row.deal] || row.queued_by || "";
      if (/^(collector|amo-hook|shared)$/.test(l)) l = "";   // служебные входы — не «чья»
      row.owner = l; row.owner_name = l ? (names[l] || l) : "";
      return row;
    },
  };
}
