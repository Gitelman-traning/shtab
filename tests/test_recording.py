import importlib.util
from pathlib import Path
import os
import sys
import shutil
import tempfile
import wave
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

    def test_video_pipeline_transcribes_only_extracted_audio_and_cleans_both_files(self):
        original = tempfile.NamedTemporaryFile(delete=False, suffix='.mp4')
        audio = tempfile.NamedTemporaryFile(delete=False, suffix='.flac')
        original.close()
        audio.close()
        stages = []
        with patch.object(recording, 'stored', return_value=None), patch.object(recording, 'deepgram_ok', return_value=True), \
             patch.object(recording, 'APIFY_TOKEN', 'synthetic'), patch.object(recording, 'DEEPGRAM_TOKEN', 'synthetic'), \
             patch.object(recording, 'apify_audio', return_value={'video_url': 'https://zoom.invalid/video.mp4'}), \
             patch.object(recording, 'download', return_value=original.name), \
             patch.object(recording, 'extract_audio', return_value=audio.name), \
             patch.object(recording, 'transcribe', return_value={}) as transcribe, \
             patch.object(recording, 'compact', return_value={}), patch.object(recording, 'share'), \
             patch.object(recording, 'labeled_text', return_value=('synthetic dialogue', 45)):
            result = recording.zoom_to_text('https://zoom.invalid/share', 'synthetic', deal=1, progress=stages.append)
        self.assertEqual(result, ('synthetic dialogue', 45, True))
        transcribe.assert_called_once_with(audio.name)
        self.assertIn('выделяю аудио из видео', stages)
        self.assertEqual(stages[-1], 'распознаю речь')
        self.assertFalse(os.path.exists(original.name))
        self.assertFalse(os.path.exists(audio.name))

    def test_flac_uses_audio_content_type(self):
        with tempfile.NamedTemporaryFile(suffix='.flac') as audio, patch.object(recording.requests, 'post') as post:
            post.return_value.status_code = 200
            recording.transcribe(audio.name)
            self.assertEqual(post.call_args.kwargs['headers']['Content-Type'], 'audio/flac')

    def test_extraction_failure_cleans_its_partial_output(self):
        out = tempfile.NamedTemporaryFile(delete=False, suffix='.flac')
        out.close()
        with patch.object(recording.tempfile, 'NamedTemporaryFile', return_value=out), \
             patch.object(recording.subprocess, 'run', side_effect=recording.subprocess.CalledProcessError(1, 'ffmpeg')):
            with self.assertRaisesRegex(RuntimeError, 'выделить аудио'):
                recording.extract_audio('synthetic.mp4')
        self.assertFalse(os.path.exists(out.name))

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg not installed in this test environment')
    def test_actual_ffmpeg_extracts_a_valid_flac(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, 'synthetic.wav')
            with wave.open(source, 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(bytes(32000))
            result = recording.extract_audio(source)
            try:
                self.assertEqual(Path(result).read_bytes()[:4], b'fLaC')
            finally:
                os.unlink(result)
