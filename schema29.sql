-- Расшифровки встреч Zoom (15.10.2026): одна запись = одна расшифровка Deepgram с разметкой говорящих.
-- Общая для ночной «Транскрибации зумов» (amo-export, Google Doc в «дпд») и разбора встречи (collector/debrief.py):
-- кто первый расшифровал — кладёт сюда, второй берёт отсюда и Deepgram повторно не зовёт.
CREATE TABLE IF NOT EXISTS transcript (
  deal INTEGER PRIMARY KEY,           -- сделка с записью (Вторая линия)
  minutes REAL NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',      -- сплошной текст (как в Google Doc)
  utt TEXT NOT NULL DEFAULT '',       -- реплики JSON [[говорящий, начало, конец, текст], …]
  source TEXT NOT NULL DEFAULT '',    -- кто расшифровал: zoom-transcribe / debrief
  share_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
