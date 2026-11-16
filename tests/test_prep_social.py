"""Preparation accepts CRM social profiles and survives unavailable external sources."""
import importlib.util
import pathlib
import sys
from types import ModuleType
import unittest
from unittest.mock import patch


# Regression checks need no installed packages or network credentials.
requests_stub = ModuleType("requests")
requests_stub.RequestException = type("RequestException", (Exception,), {})
spec = importlib.util.spec_from_file_location("prep_social_tests", pathlib.Path(__file__).resolve().parents[1] / "collector" / "prep.py")
prep = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"requests": requests_stub}):
    spec.loader.exec_module(prep)


PROFILE = "https://www.instagram.com/synthetic.shop"


def context(card=None):
    return dict(deal=123, contact=456, card=card or {}, notes=[], meet_at="", manager="", company="", niche="Торговля",
                turn="12", staff="5", city="", country="", quiz_url="")


class SocialPreparationTests(unittest.TestCase):
    def setUp(self):
        logger = patch.object(prep, "log")
        logger.start()
        self.addCleanup(logger.stop)

    def test_profile_alone_is_sufficient_but_is_not_an_official_website(self):
        ctx = context({"Компания": "-", "Сайт / соцсети": PROFILE + "?tracking=ignored"})
        self.assertEqual(prep.site_url(ctx), "")
        self.assertTrue(prep.identified(ctx, prep.site_url(ctx)))
        self.assertEqual(prep.inputs_of(ctx)["site"], PROFILE)

    def test_separate_social_field_and_mixed_links(self):
        for link in ["instagram.com/synthetic.shop", "https://vk.com/synthetic_shop", "https://t.me/synthetic_shop",
                     "https://www.facebook.com/profile.php?id=123"]:
            with self.subTest(link=link):
                self.assertTrue(prep.identified(context({"Instagram": link}), ""))
        ctx = context({"Сайт / соцсети": PROFILE + "; https://synthetic.example/about"})
        self.assertEqual(prep.site_url(ctx), "https://synthetic.example/about")
        self.assertEqual(prep.social_urls(ctx), [PROFILE])

    def test_generic_login_and_direct_message_links_do_not_identify_a_business(self):
        for value in ["https://instagram.com", "https://instagram.com/accounts/login", "https://wa.me/12345678901",
                      "https://t.me/+privateinvite", "https://t.me/joinchat/private", "-"]:
            with self.subTest(value=value):
                ctx = context({"Сайт / соцсети": value})
                self.assertFalse(prep.identified(ctx, prep.site_url(ctx)))
        self.assertFalse(prep.identified(context({"Имя": "Synthetic", "Ниша": "Торговля"}), ""))
        self.assertTrue(prep.identified(context({"Компания": "Synthetic"}), ""))

    def test_ordinary_website_is_preserved(self):
        self.assertEqual(prep.site_url(context({"Сайт": "https://synthetic.example/?from=crm"})), "https://synthetic.example/?from=crm")
        self.assertEqual(prep.social_urls(context({"Сайт": "https://synthetic.example/instagram.com/shop"})), [])

    def test_login_page_is_not_used_as_profile_content(self):
        with patch.object(prep, "fetch", return_value=("Login generic navigation " * 30, "<title>Login • Instagram</title>")):
            self.assertEqual(prep.social_profile_text(PROFILE), "")
        with patch.object(prep, "fetch", return_value=("Public company profile " * 30, "<title>Synthetic (@synthetic.shop) • Instagram</title>")):
            self.assertIn("Public company profile", prep.social_profile_text(PROFILE))

    def test_accessible_profile_is_a_source_with_no_website_crawl(self):
        with patch.object(prep, "social_profile_text", return_value="Public profile material " * 30), \
             patch.object(prep, "site_pages") as site_pages:
            material, sources, _ = prep.gather_material(context({"Instagram": PROFILE}), search=False)
        site_pages.assert_not_called()
        self.assertIn("Public profile material", material)
        self.assertEqual(sources, [{"url": PROFILE, "title": "соцсеть из CRM"}])

    def test_inaccessible_profile_and_search_failure_still_publish_ready_preparation(self):
        ctx = context({"Сайт / соцсети": PROFILE, "Оборот, млн ₽ в год": "12", "Сотрудников": "5"})
        built = "## 1. ШПАРГАЛКА\nГипотеза\n## 2. СВЕРКА ЦИФР\nCRM: 12\n## 3. ЧТО ИНТЕРЕСНОГО\n\n## 4. ЗАХОД\nВы указали…\n## 5. КЕЙСЫ\nНет"
        with patch.object(prep, "lead_context", return_value=ctx), \
             patch.object(prep, "social_profile_text", return_value=""), \
             patch.object(prep, "find_pages", side_effect=RuntimeError("search unavailable")), \
             patch.object(prep, "pick_cases", return_value=([], {})), \
             patch.object(prep, "owner_notes", return_value=("", [], {})), \
             patch.object(prep, "build_brief", return_value=(built, [], {"in": 1, "out": 1, "search": 0})), \
             patch.object(prep, "factcheck_brief", side_effect=lambda brief, usage: brief), \
             patch.object(prep, "shtab") as ingest, patch.dict(prep.os.environ, {"PREP_DOSSIER": "0"}):
            row = prep.process(123, [], "prompt", False, None)
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["inputs"]["site"], PROFILE)
        self.assertIn("Сведения о компании из него не удалось проверить", row["brief"])
        self.assertIn("Веб-поиск недоступен", row["facts"])
        self.assertEqual(row["sources"], [])
        self.assertEqual(ingest.call_args.args[:2], ("POST", "/api/ingest"))
        self.assertEqual(ingest.call_args.args[2]["prep"][0]["status"], "ready")

    def test_profile_only_does_not_assign_registry_matches_to_the_client(self):
        ctx = context({"Instagram": PROFILE})
        with patch.object(prep, "social_profile_text", return_value=""), \
             patch.object(prep, "find_pages", return_value=([("https://synthetic-news.example/story", "Связанный материал")], ["1234567890"], {})), \
             patch.object(prep, "fetch", return_value=("Source material " * 30, "")), \
             patch.object(prep, "registry") as registry:
            material, sources, _ = prep.gather_material(ctx)
        registry.assert_not_called()
        self.assertIn("Source material", material)
        self.assertEqual(sources[0]["url"], "https://synthetic-news.example/story")


if __name__ == "__main__":
    unittest.main()
