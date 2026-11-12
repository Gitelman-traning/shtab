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

    def test_cross_month_days_use_their_own_verified_report(self):
        start, end = dt.date(2026,10,30), self.day
        calls = []
        def read_days(first,last,sheet):
            calls.append((first,last,sheet))
            return [dict(ptype='day',period=first.isoformat(),value=sheet),
                    dict(ptype='month',period='2026-10',value=sheet)]
        def report(last): return last.strftime('%Y-%m')
        points = collect.monthly_points(start,end,report,read_days)
        self.assertEqual(calls,[(start,dt.date(2026,10,31),'2026-10'),(dt.date(2026,11,1),end,'2026-11')])
        self.assertEqual([p['value'] for p in points],['2026-10','2026-11','2026-11'])
        repaired = collect.monthly_points(start,end,report,read_days,repair=True)
        self.assertEqual([p['value'] for p in repaired if p['ptype']=='month'],['2026-10'])

    def test_failed_read_and_partial_write_get_distinct_status(self):
        statuses=[]
        report=lambda source,state,error: statuses.append(state)
        def fail_read(issue): raise RuntimeError('fixture')
        def fail_write(*args): raise RuntimeError('fixture')
        self.assertEqual(collect.run_feed('deals',self.day,fail_read,report,fail_write),'failed')
        self.assertEqual(collect.run_feed('deals',self.day,lambda issue: ([{}],[]),report,fail_write),'partial')
        self.assertEqual(statuses,['running','failed','running','partial'])

    def test_completed_export_distinguishes_an_empty_source_from_an_event(self):
        layout={'cols':dict(funnel='A',lead_date='B',source='C',manager='D',booked_date='E',held_date='F',sale_date='G'), 'sheet_id':'verified','export_tab':'export','first_row':5,'lead_funnel':'L1','first_line_prefix':'L1'}
        with patch.object(collect,'LAYOUT',layout), patch.object(collect,'read',return_value=[['L1','03.11.2026','Телеграм канал']]):
            pts=collect.deal_points(None,self.day-dt.timedelta(days=1),self.day)
        self.assertEqual([(p['period'],p['value']) for p in pts if p['metric']=='mkt.leads' and p['dim']=='Телеграм канал'], [('2026-11-03',1),('2026-11-02',0)])
        self.assertEqual([p['value'] for p in pts if p['metric']=='l2.sales' and p['dim']=='src:Телеграм канал'],[0,0])
        with patch.object(collect,'LAYOUT',layout), patch.object(collect,'read',return_value=[]), self.assertRaises(ValueError):
            collect.deal_points(None,self.day,self.day)

    def test_failed_readback_keeps_feed_partial(self):
        statuses = []
        def verify(points, period):
            raise RuntimeError('missing day')
        result = collect.run_feed('deals', self.day, lambda issue: ([{}], []),
                                  lambda source, state, detail: statuses.append(state), lambda *args: None, verify)
        self.assertEqual(result, 'partial')
        self.assertEqual(statuses, ['running', 'partial'])

    def test_readback_distinguishes_missing_day_from_confirmed_zero(self):
        import sys
        response = Mock()
        points = [dict(metric='mkt.leads', dim='Телеграм канал', ptype='day', period=self.day.isoformat(), value=0)]
        requests = Mock()
        requests.get.return_value = response
        with patch.dict(sys.modules, {'requests': requests}):
            response.json.return_value = dict(ok=True, rows=[])
            with self.assertRaises(RuntimeError):
                collect.verify_deal_points(points, self.day)
            response.json.return_value = dict(ok=True, rows=[dict(metric='mkt.leads', dim='Телеграм канал', value=0)])
            collect.verify_deal_points(points, self.day)
            response.json.return_value = dict(ok=True, has_more=True, rows=[])
            with self.assertRaises(RuntimeError):
                collect.verify_deal_points(points, self.day)
