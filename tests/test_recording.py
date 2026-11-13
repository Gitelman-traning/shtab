import importlib.util
from pathlib import Path
import os
import sys
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('recording', Path(__file__).resolve().parents[1] / 'collector/recording.py')
recording = importlib.util.module_from_spec(spec)
# Сетевой клиент заменён целиком: проверки сборки работают без зависимостей сборщика.
with patch.dict(sys.modules, {'requests': Mock()}):
    spec.loader.exec_module(recording)


class RecordingTests(unittest.TestCase):
    def result(self, item):
        started = Mock()
        started.json.return_value = {'data': {'id': 'synthetic'}}
        status = Mock()
        status.json.return_value = {'data': {'status': 'SUCCEEDED'}}
        dataset = Mock()
        dataset.json.return_value = [item]
        with patch.object(recording.requests, 'post', return_value=started), \
             patch.object(recording.requests, 'get', side_effect=[status, dataset]), \
             patch.object(recording.time, 'sleep'):
            return recording.apify_audio('https://zoom.invalid/share', 'synthetic', polls=1)

    def test_video_without_separate_audio_is_a_valid_recording(self):
        item = {'ok': True, 'audio_url': None, 'video_url': 'https://zoom.invalid/recording.mp4'}
        self.assertEqual(self.result(item), item)

    def test_audio_remains_preferred_when_both_files_exist(self):
        item = {'audio_url': 'https://zoom.invalid/audio.m4a', 'video_url': 'https://zoom.invalid/video.mp4'}
        self.assertEqual(recording.media_url(self.result(item)), item['audio_url'])

    def test_missing_media_still_stops_before_transcription(self):
        with self.assertRaisesRegex(RuntimeError, 'Apify'):
            self.result({'ok': False, 'error': 'recording not ready'})

    def test_video_download_preserves_access_headers_and_streams_to_a_file(self):
        response = Mock()
        response.iter_content.return_value = [b'video', b'-audio']
        item = {'video_url': 'https://zoom.invalid/recording.mp4', 'finalUrl': 'https://zoom.invalid/play', 'cookieHeader': 'synthetic=cookie'}
        with patch.object(recording.requests, 'get', return_value=response) as get:
            path = recording.download(item)
        try:
            self.assertEqual(Path(path).read_bytes(), b'video-audio')
            self.assertEqual(get.call_args.args[0], item['video_url'])
            self.assertEqual(get.call_args.kwargs['headers']['Cookie'], item['cookieHeader'])
            self.assertEqual(get.call_args.kwargs['headers']['Referer'], item['finalUrl'])
            self.assertTrue(get.call_args.kwargs['stream'])
        finally:
            os.unlink(path)
