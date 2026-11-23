"""Collector selection must match the two current sales pipelines in the report."""
import importlib.util
import pathlib
import unittest

source=pathlib.Path(__file__).resolve().parents[1]/'collector'/'youtube.py'
spec=importlib.util.spec_from_file_location('youtube_scope',source)
youtube=importlib.util.module_from_spec(spec)
spec.loader.exec_module(youtube)

def lead(pipeline,source=True):
    return {'id':1,'pipeline_id':pipeline,'status_id':142,'created_at':1,'price':100,
            'custom_fields_values':[{'field_id':youtube.F_SRC,'values':[{'enum_id':1218221}]}] if source else []}

class YouTubePipelinesTests(unittest.TestCase):
    def test_current_lines_and_success_flags(self):
        first=youtube.yt_row(lead(8733326))
        self.assertEqual((first['meeting'],first['paid']),(1,0))
        second=youtube.yt_row(lead(9701010))
        self.assertEqual((second['meeting'],second['paid']),(0,1))
    def test_archive_reanimation_duplicates_and_unknown_are_dropped(self):
        for pipeline in [8733518,10637862,6609134,10639774,10242466,0]:
            with self.subTest(pipeline=pipeline):
                self.assertIsNone(youtube.yt_row(lead(pipeline)))
    def test_source_and_utm_rules_still_apply_within_current_lines(self):
        row=lead(8733326,False)
        self.assertIsNone(youtube.yt_row(row))
        row['custom_fields_values']=[{'field_id':453161,'values':[{'value':'youtube'}]}]
        self.assertEqual(youtube.yt_row(row)['src'],'utm_source')
        row['pipeline_id']=10637862
        self.assertIsNone(youtube.yt_row(row))
    def test_contact_payment_collection_only_requests_current_second_line(self):
        calls=[]
        old=youtube.leads
        try:
            youtube.leads=lambda params,label: calls.append(dict(params)) or []
            self.assertEqual(youtube.paid_rows(),[])
        finally:
            youtube.leads=old
        self.assertEqual(calls[0]['filter[statuses][0][pipeline_id]'],9701010)
        self.assertNotIn('filter[statuses][1][pipeline_id]',calls[0])

if __name__=='__main__':unittest.main()
