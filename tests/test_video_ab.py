import asyncio
import builtins
from fractions import Fraction
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import av
import numpy as np
from PIL import Image
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


PLUGIN = Path(__file__).resolve().parents[1]
WORKFLOW = PLUGIN / 'workflows/MediaAB_Example.json'


class FileVideo:
    def __init__(self, path):
        self.path = path

    def get_stream_source(self):
        return self.path


def load_plugin(path, name, folders, routes):
    server = types.ModuleType('server')
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
    comfy_api = types.ModuleType('comfy_api')
    comfy_api.__path__ = []
    latest = types.ModuleType('comfy_api.latest')
    latest.InputImpl = types.SimpleNamespace(VideoFromFile=FileVideo)
    modules = {'folder_paths': folders, 'server': server, 'comfy_api': comfy_api, 'comfy_api.latest': latest}
    spec = importlib.util.spec_from_file_location(name, path / '__init__.py', submodule_search_locations=[str(path)])
    module = importlib.util.module_from_spec(spec)
    modules[name] = module
    original_import = builtins.__import__

    def import_guard(import_name, *args, **kwargs):
        if import_name.split('.')[0] in ('torch', 'cv2'):
            raise AssertionError('A/B must import independently: ' + import_name)
        return original_import(import_name, *args, **kwargs)

    with patch.dict(sys.modules, modules):
        with patch('builtins.__import__', side_effect=import_guard):
            spec.loader.exec_module(module)
    return module


class VideoABTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=PLUGIN / 'tests')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.folders = types.ModuleType('folder_paths')
        for kind in ('input', 'output', 'temp'):
            directory = self.root / kind
            directory.mkdir()
            setattr(self.folders, 'get_' + kind + '_directory', lambda path=directory: str(path))

        def annotated(name):
            kind = 'input'
            for candidate in ('input', 'output', 'temp'):
                suffix = f' [{candidate}]'
                if name.endswith(suffix):
                    name, kind = name[:-len(suffix)], candidate
                    break
            root = (self.root / kind).resolve()
            path = (root / name).resolve()
            if not path.is_relative_to(root):
                raise ValueError('Path outside media root')
            return str(path)

        self.folders.get_annotated_filepath = annotated
        self.routes = web.RouteTableDef()
        self.module_name = 'video_ab_' + self.id().rsplit('.', 1)[-1]
        self.module = load_plugin(PLUGIN, self.module_name, self.folders, self.routes)
        self.addCleanup(self.clear_modules)
        self.addCleanup(self.module.scrub_cache.worker.shutdown, wait=True)
        self.source = self.root / 'input' / 'video_ab' / 'sample.mp4'
        self.source.parent.mkdir()
        with av.open(str(self.source), 'w') as container:
            stream = container.add_stream('mpeg4', rate=24)
            stream.width, stream.height, stream.pix_fmt = 32, 24, 'yuv420p'
            for _ in range(3):
                frame = av.VideoFrame(32, 24, 'yuv420p')
                for index, plane in enumerate(frame.planes):
                    plane.update(bytes([96 if index == 0 else 128]) * plane.buffer_size)
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        self.output = self.root / 'output' / 'processed.mp4'
        shutil.copyfile(self.source, self.output)

    def clear_modules(self):
        for name in list(sys.modules):
            if name.startswith(self.module_name + '.'):
                del sys.modules[name]

    def sources(self):
        return [{'loader': 'VideoPath', 'file': 'input/video_ab/sample.mp4', 'label': '原视频'},
                {'loader': 'VideoPath', 'file': 'output/processed.mp4', 'label': '处理后'}]

    def test_path_workflow_schema_and_compare_payload(self):
        workflow = json.loads(WORKFLOW.read_text(encoding='utf-8'))
        self.assertEqual({node['type'] for node in workflow['nodes'] if node['type'] != 'MarkdownNote'},
                         {'VideoEditCompare', 'ImageEditCompare'})
        self.assertEqual(set(self.module.NODE_CLASS_MAPPINGS), {'VideoEditCompare', 'ImageEditCompare'})
        compare = self.module.VideoEditCompare
        self.assertEqual(list(compare.INPUT_TYPES()['required']), ['video_a', 'video_b'])
        for name in ('video_a', 'video_b'):
            spec = compare.INPUT_TYPES()['required'][name]
            self.assertEqual(spec[0], 'VIDEO,VHS_FILENAMES,STRING')
            self.assertEqual(spec[1]['default'], '')
            self.assertFalse(spec[1].get('forceInput', False))
        self.assertEqual(compare.RETURN_TYPES, ())
        self.assertTrue(compare.OUTPUT_NODE)
        result = compare().compare(str(self.source), str(self.output))
        fps = result['ui']['video_ab'][0]['fps']
        self.assertEqual(Fraction(fps), 24)
        self.assertNotIn('result', result)
        self.assertEqual(result['ui']['video_ab'], [
            {'filename': 'sample.mp4', 'subfolder': 'video_ab', 'type': 'input', 'fps': fps, 'version': f'{self.source.stat().st_mtime_ns}-{self.source.stat().st_size}'},
            {'filename': 'processed.mp4', 'subfolder': '.', 'type': 'output', 'fps': fps, 'version': f'{self.output.stat().st_mtime_ns}-{self.output.stat().st_size}'}])

    def test_input_output_native_loader_and_external_copy(self):
        expected = self.module.compare_preview_files(self.sources())
        self.assertEqual([clip['type'] for clip in expected], ['input', 'output'])
        native = [{'loader': 'LoadVideo', 'file': 'video_ab/sample.mp4', 'label': 'A'},
                  {'loader': 'LoadVideo', 'file': 'processed.mp4 [output]', 'label': 'B'}]
        self.assertEqual([clip['filename'] for clip in self.module.compare_preview_files(native)], ['sample.mp4', 'processed.mp4'])
        external = self.root / 'external.mp4'
        shutil.copyfile(self.source, external)
        source = {'loader': 'VideoPath', 'file': '"' + str(external) + '"'}
        clips = self.module.compare_preview_files([source, self.sources()[0]])
        self.assertEqual(clips[0]['type'], 'temp')
        self.assertEqual(clips[0]['subfolder'], 'video_ab')
        copied = self.root / 'temp' / clips[0]['subfolder'] / clips[0]['filename']
        self.assertEqual(hashlib.sha256(copied.read_bytes()).digest(), hashlib.sha256(external.read_bytes()).digest())


    def test_saved_files_are_served_directly_without_reencoding(self):
        final = self.root / 'output' / 'final-audio.mp4'
        shutil.copyfile(self.output, final)
        result = self.module.VideoEditCompare().compare(str(self.source), str(final))
        self.assertEqual(result['ui']['video_ab'][1]['filename'], final.name)
        self.assertEqual(result['ui']['video_ab'][1]['type'], 'output')
        self.assertFalse((self.root / 'temp' / 'video_ab').exists())
        self.assertEqual(final.read_bytes(), self.output.read_bytes())

    def test_path_strings_relative_roots_annotations_and_change_detection(self):
        paths = [str(self.source), '"' + str(self.source) + '"', 'input/video_ab/sample.mp4',
                 'video_ab/sample.mp4', 'processed.mp4 [output]', 'output/processed.mp4']
        for path in paths:
            result = self.module.VideoEditCompare().compare(path, str(self.output))
            self.assertEqual(result['ui']['video_ab'][0]['filename'], 'processed.mp4' if 'processed' in path else 'sample.mp4')
        compare = self.module.VideoEditCompare
        before = compare.IS_CHANGED(str(self.source), str(self.output))
        self.output.touch()
        after = compare.IS_CHANGED(str(self.source), str(self.output))
        self.assertNotEqual(before, after)
        descriptors = self.module.compare_preview_files([{'loader': 'VideoPath', 'file': str(self.source)},
                                                        {'loader': 'VideoPath', 'file': 'output/processed.mp4'}])
        self.assertEqual([clip['type'] for clip in descriptors], ['input', 'output'])

    def test_unsupported_inputs_and_invalid_paths_are_rejected(self):
        for value in ([str(self.source)], (True, []), (True, [str(self.source.with_suffix('.png'))]), 123):
            with self.assertRaises(ValueError):
                self.module.VideoEditCompare().compare(value, str(self.output))
        for path in ('https://example.com/video.mp4', 'input/../../outside.mp4', '../outside.mp4', str(self.source.with_suffix('.txt'))):
            with self.assertRaises(ValueError):
                self.module.VideoEditCompare().compare(path, str(self.output))

    def test_empty_video_panel_and_single_side_can_execute(self):
        compare = self.module.VideoEditCompare()
        for empty in ('', '  ', None):
            result = compare.compare(empty, empty)
            self.assertEqual(result['ui']['video_ab'], [None, None])
            self.assertEqual(compare.IS_CHANGED(empty, empty), (None, None))
            result = compare.compare(str(self.source), empty)
            self.assertEqual(result['ui']['video_ab'][0]['filename'], 'sample.mp4')
        workflow = json.loads(WORKFLOW.read_text(encoding='utf-8'))
        node = next(n for n in workflow['nodes'] if n['type'] == 'VideoEditCompare')
        self.assertEqual(node['widgets_values'][:2], ['', ''])
        self.assertFalse(node.get('properties', {}).get('video_ab'))

    def test_missing_video_does_not_block_other_preview_side(self):
        async def check():
            app = web.Application()
            app.add_routes(self.routes)
            async with TestClient(TestServer(app)) as client:
                missing = {'loader': 'VideoPath', 'file': 'output/deleted.mp4'}
                valid = self.sources()[0]
                for sources, bad_index in (([missing, valid], 0), ([valid, missing], 1)):
                    response = await client.post('/video_ab/compare_preview', json={'sources': sources})
                    self.assertEqual(response.status, 200)
                    data = await response.json()
                    self.assertIsNone(data['video_ab'][bad_index])
                    self.assertEqual(data['video_ab'][1 - bad_index]['filename'], 'sample.mp4')
                    self.assertIn('deleted.mp4', data['errors'][bad_index])
                response = await client.post('/video_ab/compare_preview', json={'sources': [None, None]})
                self.assertEqual(await response.json(), {'video_ab': [None, None], 'errors': [None, None]})
        asyncio.run(check())

    def test_native_video_and_vhs_files_share_the_path_input(self):
        video = FileVideo(str(self.source))
        result = self.module.VideoEditCompare().compare(video, (True, ['metadata.png', str(self.source), str(self.output)]))
        self.assertEqual([clip['filename'] for clip in result['ui']['video_ab']], ['sample.mp4', 'processed.mp4'])
        self.assertFalse((self.root / 'temp/video_ab').exists())
        self.assertEqual(self.module.VideoEditCompare.IS_CHANGED(video, str(self.output))[0], None)

    def test_memory_video_is_materialized_for_preview(self):
        video = FileVideo(io.BytesIO(self.source.read_bytes()))
        video.path.seek(9)
        result = self.module.VideoEditCompare().compare(video, str(self.output))
        clip = result['ui']['video_ab'][0]
        self.assertEqual(clip['type'], 'temp')
        self.assertEqual((self.root / 'temp' / clip['subfolder'] / clip['filename']).read_bytes(), self.source.read_bytes())
        self.assertEqual(video.path.tell(), 9)

    def test_trimmed_video_uses_the_video_api_instead_of_raw_source(self):
        class TrimmedVideo(FileVideo):
            def get_active_trim_window(self): return (0.04, 0.04)
            def save_to(self, destination):
                self.saved = True
                shutil.copyfile(self.path, destination)
        video = TrimmedVideo(str(self.source))
        result = self.module.VideoEditCompare().compare(video, str(self.output))
        self.assertTrue(video.saved)
        self.assertEqual(result['ui']['video_ab'][0]['type'], 'temp')

    def test_trimmed_memory_preview_uses_saved_clip_and_restores_cursor(self):
        class TrimmedVideo(FileVideo):
            def get_active_trim_window(self):
                self.path.seek(0, io.SEEK_END)
                return (0, 1 / 24)

            def save_to(self, destination):
                self.path.seek(0)
                with av.open(self.path) as original, av.open(destination, 'w') as output:
                    frame = next(original.decode(video=0))
                    stream = output.add_stream('mpeg4', rate=24)
                    stream.width, stream.height = frame.width, frame.height
                    output.mux(stream.encode(frame))
                    output.mux(stream.encode())

        buffer = io.BytesIO(self.source.read_bytes())
        buffer.seek(9)
        clip = self.module.VideoEditCompare().compare(TrimmedVideo(buffer), None)['ui']['video_ab'][0]
        self.assertEqual(buffer.tell(), 9)
        with av.open(str(self.root / 'temp' / clip['subfolder'] / clip['filename'])) as preview:
            self.assertEqual(len(list(preview.decode(video=0))), 1)

    def test_trimmed_memory_save_failure_restores_cursor_and_removes_partial_file(self):
        class BrokenVideo(FileVideo):
            def get_active_trim_window(self):
                return (1 / 24, 0)

            def save_to(self, destination):
                self.path.seek(0)
                Path(destination).write_bytes(b'partial')
                raise TypeError('encoder failed')

        buffer = io.BytesIO(self.source.read_bytes())
        buffer.seek(9)
        with self.assertRaisesRegex(TypeError, 'encoder failed'):
            self.module.preview_video(BrokenVideo(buffer))
        self.assertEqual(buffer.tell(), 9)
        self.assertEqual(list((self.root / 'temp/video_ab').iterdir()), [])

    def test_partial_path_selection_previews_one_side(self):
        clips = self.module.compare_preview_files([{'loader': 'VideoPath', 'file': str(self.source)}, None])
        self.assertEqual(clips[0]['filename'], self.source.name)
        self.assertIsNone(clips[1])
        self.assertEqual(self.module.compare_preview_files([{'loader': 'VideoPath', 'file': ''}, None]), [None, None])

    def test_image_comparison_preserves_different_sizes_and_first_batch_frame(self):
        class Pixels:
            def __init__(self, array): self.array = array
            def __getitem__(self, index): return Pixels(self.array[index])
            def detach(self): return self
            def cpu(self): return self
            def numpy(self): return self.array

        a = Pixels(np.ones((2, 12, 16, 3), dtype=np.float32))
        b = Pixels(np.zeros((1, 24, 32, 3), dtype=np.float32))
        result = self.module.ImageEditCompare().compare(a, b, '原图', '放大后')
        self.assertEqual(self.module.ImageEditCompare.RETURN_TYPES, ())
        self.assertEqual([clip['label'] for clip in result['ui']['image_ab']], ['原图', '放大后'])
        for clip, size, pixel in zip(result['ui']['image_ab'], [(16, 12), (32, 24)], [255, 0]):
            self.assertEqual(clip['type'], 'temp')
            with Image.open(self.root / 'temp' / clip['subfolder'] / clip['filename']) as image:
                self.assertEqual(image.size, size)
                self.assertEqual(image.getpixel((0, 0)), (pixel, pixel, pixel))

    def test_hd_scrub_cache_keeps_dimensions_timestamps_and_keyframes(self):
        cache = self.module.scrub_cache
        source = {'filename': self.source.name, 'subfolder': 'video_ab', 'type': 'input'}
        job = cache.prepare(source)
        cache.worker.submit(lambda: None).result(timeout=30)
        state = cache.status(job['key'])
        self.assertEqual(state['status'], 'ready', state)
        proxy = self.root / 'temp' / state['proxy']['subfolder'] / state['proxy']['filename']
        with av.open(str(self.source)) as original, av.open(str(proxy)) as preview:
            self.assertEqual((preview.streams.video[0].width, preview.streams.video[0].height), (32, 24))
            self.assertEqual(original.streams.video[0].average_rate, preview.streams.video[0].average_rate)
            expected = [frame.pts * frame.time_base for frame in original.decode(video=0)]
            frames = list(preview.decode(video=0))
            self.assertEqual([frame.pts * frame.time_base for frame in frames], expected)
            self.assertTrue(all(frame.key_frame for frame in frames))
            self.assertFalse(preview.streams.audio)
        self.assertTrue(cache.prepare(source)['cache_hit'])
        self.assertEqual(cache.prepare(source)['key'], job['key'])
        self.source.touch()
        changed = cache.prepare(source)
        self.assertNotEqual(changed['key'], job['key'])
        cache.worker.submit(lambda: None).result(timeout=30)

    def test_hd_cache_rejects_escaped_paths_and_reports_encoding_failure(self):
        cache = self.module.scrub_cache
        for source in (None, [], {'filename': '../outside.mp4', 'type': 'input'},
                       {'filename': str(self.source), 'type': 'output'}):
            with self.assertRaises(ValueError):
                cache.prepare(source)
        broken = self.root / 'input' / 'broken.mp4'
        broken.write_bytes(b'not a video')
        job = cache.prepare({'filename': broken.name, 'type': 'input'})
        cache.worker.submit(lambda: None).result(timeout=30)
        self.assertEqual(cache.status(job['key'])['status'], 'error')
        self.assertIsNone(cache.status('../outside'))

    def test_hd_scrub_cache_preserves_vfr_and_positive_start_offset(self):
        source = self.root / 'input' / 'vfr.mp4'
        with av.open(str(source), 'w') as container:
            stream = container.add_stream('libx264', rate=Fraction(24000, 1001))
            stream.width, stream.height, stream.pix_fmt = 64, 48, 'yuv420p'
            stream.options = {'crf': '15', 'bf': '0'}
            for index, pts in enumerate([48000, 49001, 52004, 54006]):
                frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), 50 + index * 30, dtype=np.uint8), format='rgb24')
                frame.pts, frame.time_base = pts, Fraction(1, 24000)
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        cache = self.module.scrub_cache
        job = cache.prepare({'filename': source.name, 'type': 'input'})
        cache.worker.submit(lambda: None).result(timeout=30)
        state = cache.status(job['key'])
        self.assertEqual(state['status'], 'ready', state)
        proxy = self.root / 'temp' / state['proxy']['subfolder'] / state['proxy']['filename']
        with av.open(str(source)) as original, av.open(str(proxy)) as preview:
            expected = [frame.pts * frame.time_base for frame in original.decode(video=0)]
            actual = [frame.pts * frame.time_base for frame in preview.decode(video=0)]
            self.assertGreater(expected[0], 0)
            self.assertEqual(actual, expected)

    def test_empty_image_panel_does_not_block_video_workflow(self):
        node = self.module.ImageEditCompare
        self.assertEqual(node.INPUT_TYPES()['required'], {})
        self.assertEqual(set(node.INPUT_TYPES()['optional']), {'image_a', 'image_b'})
        self.assertEqual(node().compare()['ui']['image_ab'], [None, None])

    def test_paths_and_bad_request_data_are_rejected(self):
        for file in ('input/../../external.mp4', 'output/../external.mp4', 'remote/sample.mp4', 'sample.mp4'):
            with self.assertRaises(ValueError):
                self.module.resolve_video_path(file)
        for sources in (None, [], [12, None], [{'loader': 'unknown', 'file': 'x'}, self.sources()[0]],
                        [{'loader': 'LoadVideo', 'file': '../external.mp4'}, self.sources()[0]]):
            with self.assertRaises(ValueError):
                self.module.compare_preview_files(sources)

    def test_preview_routes_register_once_and_return_identical_responses(self):
        paths = ('/video_ab/compare_preview', '/video_editing/compare_preview')
        routes = [route.path for route in self.routes]
        for path in paths:
            self.assertEqual(routes.count(path), 1)

        async def check():
            app = web.Application()
            app.add_routes(self.routes)
            async with TestClient(TestServer(app)) as client:
                for body, status in (({'sources': self.sources()}, 200), ({'sources': None}, 400), ([], 400)):
                    results = []
                    for path in paths:
                        response = await client.post(path, json=body)
                        self.assertEqual(response.status, status)
                        results.append(await response.json())
                    self.assertEqual(results[0], results[1])
                    if status == 200:
                        self.assertEqual([clip['filename'] for clip in results[0]['video_ab']], ['sample.mp4', 'processed.mp4'])
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main(verbosity=2)
