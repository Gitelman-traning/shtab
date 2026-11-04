import datetime as dt
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('collect', Path(__file__).resolve().parents[1] / 'collector/collect.py')
collect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collect)


class ReportTests(unittest.TestCase):
    day = dt.date(2026, 11, 3)

    def select(self, stamp, hint='nov', candidates=()):
        service = Mock()
        titles = {'old': '09.26 - Report', 'nov': '11.26 - Report'}
        service.get.side_effect = lambda spreadsheetId, fields: Mock(execute=lambda: {'properties': {'title': titles[spreadsheetId]}})
        drive = Mock()
        drive.files.return_value.list.return_value.execute.return_value = {'files': [{'id': id} for id in candidates]}
        with patch.dict(os.environ, {'REPORT_SHEET_ID':hint,'REPORT_STAMP_RANGE':'Raw!KO1:KP80'}), patch.object(collect,'LAYOUT',{'sheet_id':'old'}), patch.object(collect,'google_service',return_value=drive), patch.object(collect,'read',return_value=stamp):
            return collect.monthly_report(service,None,self.day)

    def test_confirmed_report(self):
        self.assertEqual(self.select([['export_date','03.11.2026']]), 'nov')

    def test_stale_hint_discovers_unique_month(self):
        self.assertEqual(self.select([['export_date','03.11.2026']], 'old', ['nov']), 'nov')

    def test_missing_or_ambiguous_month_is_not_published(self):
        for matches in [[],['nov','duplicate']]:
            with self.assertRaises(ValueError):
                self.select([['export_date','03.11.2026']], 'old', matches)

    def test_missing_stale_and_duplicate_markers_fail(self):
        for stamp in [[], [['export_date','02.11.2026']], [['export_date','bad']], [['export_date','03.11.2026']]*2]:
            with self.assertRaises(ValueError):
                self.select(stamp)

    def test_completed_export_distinguishes_an_empty_source_from_an_event(self):
        layout={'cols':dict(funnel='A',lead_date='B',source='C',manager='D',booked_date='E',held_date='F',sale_date='G'), 'sheet_id':'verified','export_tab':'export','first_row':5,'lead_funnel':'L1','first_line_prefix':'L1'}
        with patch.object(collect,'LAYOUT',layout), patch.object(collect,'read',return_value=[['L1','03.11.2026','Телеграм канал']]):
            pts=collect.deal_points(None,self.day-dt.timedelta(days=1),self.day)
        self.assertEqual([(p['period'],p['value']) for p in pts if p['metric']=='mkt.leads' and p['dim']=='Телеграм канал'], [('2026-11-03',1),('2026-11-02',0)])
        self.assertEqual([p['value'] for p in pts if p['metric']=='l2.sales' and p['dim']=='src:Телеграм канал'],[0,0])
        with patch.object(collect,'LAYOUT',layout), patch.object(collect,'read',return_value=[]), self.assertRaises(ValueError):
            collect.deal_points(None,self.day,self.day)
