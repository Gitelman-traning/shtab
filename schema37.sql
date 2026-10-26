-- Штаб, миграция 37 (26.10.2026): реестр Instagram-каналов (Маркетинг → Instagram SMM → Каналы).
-- У каждого канала своя ссылка на бота: t.me/<бот>?start=gitelman_instagram_<slug>. Движок разбирает метку
-- как utm_source=instagram (поле «Источник» в amo), utm_campaign=<slug> (тег сделки). slug = ник в нижнем регистре,
-- точки → дефис (Telegram в start-параметре принимает только A-Za-z0-9_-).
-- Статистику по каналам страница берёт из ядра ботов (по utm_campaign) и из витрины срезов amo (seg.*|c|<slug>).
-- Применять: cd site && CLOUDFLARE_ACCOUNT_ID=4c42f9a718e4aeee45e5e2a57a9d795f npx wrangler -c wrangler.reference.toml d1 execute shtab --remote --yes --file ../schema37.sql

CREATE TABLE IF NOT EXISTS ig_channels (
  slug       TEXT PRIMARY KEY,                 -- метка кампании, она же тег в amo
  nick       TEXT NOT NULL,                    -- ник в Instagram (нижний регистр, как в адресе профиля)
  pos        INTEGER NOT NULL DEFAULT 0,       -- порядок в списке
  note       TEXT NOT NULL DEFAULT '',         -- заметка: кто ведёт, тема
  archived   INTEGER NOT NULL DEFAULT 0,       -- канал закрыт: ссылка остаётся рабочей, в списке внизу
  added_by   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- первые 42 канала из сообщения Никиты 26.10.2026
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavelgit_p', 'pavelgit_p', 1, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('gitelpavel', 'gitelpavel', 2, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pa.vel.pp', 'pa-vel-pp', 3, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pave.el10', 'pave-el10', 4, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pav_getel', 'pav_getel', 5, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('paaveel102', 'paaveel102', 6, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pasha.pavel10', 'pasha-pavel10', 7, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('komanda_pavel', 'komanda_pavel', 8, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('komandasilnye', 'komandasilnye', 9, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavvel09', 'pavvel09', 10, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavel_pavel10', 'pavel_pavel10', 11, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('get_pav_el', 'get_pav_el', 12, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('komandanajm.pavel', 'komandanajm-pavel', 13, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('uprav_pavel', 'uprav_pavel', 14, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavel_bizidea', 'pavel_bizidea', 15, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pro_pavel_e', 'pro_pavel_e', 16, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('motiv_pavel', 'motiv_pavel', 17, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('kom_pavel_g', 'kom_pavel_g', 18, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('uprav_pasha', 'uprav_pasha', 19, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('sistem_paveel', 'sistem_paveel', 20, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('komandabiznesidei', 'komandabiznesidei', 21, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('komandamotivacia', 'komandamotivacia', 22, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('paavveell2026', 'paavveell2026', 23, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('paveltut_es', 'paveltut_es', 24, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('effekt_pavell', 'effekt_pavell', 25, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('lop.paveeel', 'lop-paveeel', 26, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pave_leto', 'pave_leto', 27, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pav_el201', 'pav_el201', 28, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('lider_pavelget', 'lider_pavelget', 29, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavel_gettel', 'pavel_gettel', 30, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('ppavelola', 'ppavelola', 31, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('biz.pavel', 'biz-pavel', 32, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('lid.er_pavel', 'lid-er_pavel', 33, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavel_lider', 'pavel_lider', 34, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavl.gettl', 'pavl-gettl', 35, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('get_pavel', 'get_pavel', 36, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('bizz_pavel', 'bizz_pavel', 37, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('lid.pavel', 'lid-pavel', 38, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('lider.pav.el', 'lider-pav-el', 39, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('komand.a_pavel', 'komand-a_pavel', 40, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('paavveel_biz', 'paavveel_biz', 41, 'nikita', '2026-10-26T00:00:00Z');
INSERT OR IGNORE INTO ig_channels (nick, slug, pos, added_by, created_at) VALUES ('pavel_gett_lider', 'pavel_gett_lider', 42, 'nikita', '2026-10-26T00:00:00Z');
