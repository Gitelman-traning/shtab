/**
 * Вопрос по конкретной встрече.
 *
 * Принимает {deal, question}, достаёт расшифровку этой встречи из KV
 * и отвечает по ней через OpenRouter. Доступ уже проверен в _middleware:
 * без пароля сюда не попасть.
 *
 * Провайдер — любой OpenAI-совместимый: секреты LLM_BASE_URL + LLM_API_KEY
 * (например ProxyAPI). Без них — OpenRouter с ключом OPENROUTER_API_KEY и бесплатными моделями.
 */

const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const PAID_MODEL = "anthropic/claude-sonnet-5";   // модель у платного провайдера, если ASK_MODEL не задан
const FREE_MAX_CHARS = 45000;    // бесплатным моделям — обрезка
const PAID_MAX_CHARS = 250000;   // платным — расшифровка целиком
const FALLBACK = [
  "minimax/minimax-m3:free",
  "z-ai/glm-5.2:free",
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

const SYSTEM = `Ты помогаешь руководителю отдела продаж разобрать встречу с клиентом.
Отвечаешь ТОЛЬКО по расшифровке этой встречи.

Правила:
1. Нет ответа в расшифровке — так и скажи: «в расшифровке этого нет». Не додумывай.
2. Подкрепляй ответ короткой цитатой из разговора, если она есть.
3. Расшифровка автоматическая, в ней есть ошибки распознавания — восстанавливай смысл,
   но не выдумывай факты, цифры и имена.
4. Отвечай по-русски, коротко и по делу: несколько предложений, без вступлений.`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const base = (env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const key = env.LLM_API_KEY || env.OPENROUTER_API_KEY;
  const paid = !!env.LLM_BASE_URL && !/openrouter\.ai/.test(base);
  const OR = base + "/chat/completions";
  const MAX_CHARS = paid ? PAID_MAX_CHARS : FREE_MAX_CHARS;
  if (!key) {
    return json({ error: "Ключ модели не настроен. Добавьте секреты LLM_BASE_URL и LLM_API_KEY в проект." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Не разобрал запрос" }, 400);
  }
  const deal = String(body.deal || "").trim();
  const question = String(body.question || "").trim().slice(0, 500);
  if (!deal || !question) return json({ error: "Нужны сделка и вопрос" }, 400);

  const transcript = await env.OKK_KV.get("t:" + deal);
  if (!transcript) {
    return json({ error: "Расшифровка этой встречи ещё не загружена" }, 404);
  }
  // хвост встречи важнее: там закрытие и договорённости
  const text = transcript.length <= MAX_CHARS
    ? transcript
    : transcript.slice(0, MAX_CHARS / 3) + "\n…\n" + transcript.slice(-2 * MAX_CHARS / 3);

  const models = paid ? [env.ASK_MODEL || PAID_MODEL] : (env.ASK_MODEL ? [env.ASK_MODEL, ...FALLBACK] : FALLBACK);
  const headers = {
    "Authorization": "Bearer " + key,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://okk-dashboard.pages.dev",
    "X-Title": "OKK ask",
  };

  let lastError = "";
  for (const model of models) {
    try {
      const r = await fetch(OR, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: "Расшифровка встречи:\n\n" + text + "\n\nВопрос: " + question },
          ],
        }),
      });
      if (r.status === 429) { lastError = "модели заняты"; continue; }
      if (!r.ok) { lastError = "ответ " + r.status; continue; }
      const data = await r.json();
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const answer = (msg.content || msg.reasoning || "").trim();
      if (!answer) { lastError = "пустой ответ"; continue; }
      return json({ answer, model });
    } catch (e) {
      lastError = String(e).slice(0, 120);
    }
  }
  return json({ error: "Модель не ответила (" + lastError + "). Попробуйте ещё раз." }, 502);
}
