import asyncio
import os
from pathlib import Path

from aiohttp import web
import folder_paths
from comfy_api.latest import InputImpl
from server import PromptServer

from .media import EXTENSIONS, preview_file, preview_video, resolve_video_path, vhs_video_path
from .image_compare import ImageEditCompare
from .scrub_cache import ScrubCache


CATEGORY = 'MediaAB'
VIDEO_INPUT = 'VIDEO,VHS_FILENAMES,STRING'


def video_input(value):
    if isinstance(value, (tuple, list)):
        return InputImpl.VideoFromFile(str(vhs_video_path(value)))
    if isinstance(value, (str, os.PathLike)):
        return InputImpl.VideoFromFile(str(resolve_video_path(value)))
    if not callable(getattr(value, 'get_stream_source', None)):
        raise ValueError('请连接 VIDEO、视频路径 STRING 或 VHS Filenames；IMAGE 帧批次请先接 CreateVideo。')
    return value


class VideoEditCompare:
    @classmethod
    def INPUT_TYPES(cls):
        options = {'default': '', 'tooltip': 'Select or drop a video, or connect a video, file path, or VHS Filenames output.'}
        return {'required': {'video_a': (VIDEO_INPUT, options), 'video_b': (VIDEO_INPUT, dict(options))}}

    RETURN_TYPES = ()
    FUNCTION = 'compare'
    CATEGORY = CATEGORY
    OUTPUT_NODE = True
    DESCRIPTION = 'Compare two videos with synchronized playback and frame stepping.'

    @classmethod
    def IS_CHANGED(cls, video_a, video_b):
        states = []
        for value in (video_a, video_b):
            if value is None or isinstance(value, str) and not value.strip():
                states.append(None)
                continue
            if not isinstance(value, (str, os.PathLike, tuple, list)):
                states.append(None)
                continue
            try:
                path = vhs_video_path(value) if isinstance(value, (tuple, list)) else resolve_video_path(value)
                stat = path.stat()
            except (ValueError, OSError):
                return float('nan')
            states.append((str(path), stat.st_mtime_ns, stat.st_size))
        return tuple(states)

    def compare(self, video_a='', video_b=''):
        videos = [None if value is None or isinstance(value, str) and not value.strip()
                  else video_input(value) for value in (video_a, video_b)]
        clips = [preview_video(video) if video is not None else None for video in videos]
        return {'ui': {'video_ab': clips}}


def compare_preview_files(sources):
    if not isinstance(sources, list) or len(sources) != 2:
        raise ValueError('请选择 A、B 两个视频。')
    clips = []
    for source in sources:
        if source is None:
            clips.append(None)
            continue
        if not isinstance(source, dict) or not isinstance(source.get('file'), str):
            raise ValueError('视频素材格式无效。')
        if not source['file'].strip():
            clips.append(None)
            continue
        if source.get('loader') == 'LoadVideo':
            path = Path(folder_paths.get_annotated_filepath(source['file']))
        elif source.get('loader') == 'VideoPath':
            path = resolve_video_path(source['file'])
        else:
            raise ValueError('自动预览支持视频文件加载器和本地视频路径。')
        if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
            raise ValueError(f'找不到可预览的视频：{path.name}')
        clips.append(preview_file(path))
    return clips


@PromptServer.instance.routes.post('/video_ab/compare_preview')
@PromptServer.instance.routes.post('/video_editing/compare_preview')
async def compare_preview(request):
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError('视频对比请求格式无效。')
        sources = data.get('sources')
        if not isinstance(sources, list) or len(sources) != 2:
            raise ValueError('请选择 A、B 两个视频。')
    except (ValueError, KeyError, TypeError, OSError) as error:
        return web.json_response({'error': str(error)}, status=400)
    clips, errors = [], []
    for source in sources:
        try:
            pair = await asyncio.to_thread(compare_preview_files, [source, None])
            clips.append(pair[0])
            errors.append(None)
        except (ValueError, KeyError, TypeError, OSError) as error:
            clips.append(None)
            errors.append(str(error))
    return web.json_response({'video_ab': clips, 'errors': errors})


scrub_cache = ScrubCache()


@PromptServer.instance.routes.post('/video_ab/scrub_prepare')
async def scrub_prepare(request):
    try:
        state = await asyncio.to_thread(scrub_cache.prepare, await request.json())
    except (ValueError, TypeError, OSError) as error:
        return web.json_response({'error': str(error)}, status=400)
    return web.json_response(state)


@PromptServer.instance.routes.get('/video_ab/scrub_status/{key}')
async def scrub_status(request):
    state = scrub_cache.status(request.match_info['key'])
    return web.json_response(state or {'error': '缓存任务已失效。'}, status=200 if state else 404)


NODE_CLASS_MAPPINGS = {'VideoEditCompare': VideoEditCompare, 'ImageEditCompare': ImageEditCompare}
NODE_DISPLAY_NAME_MAPPINGS = {
    'VideoEditCompare': 'Video A/B Compare',
    'ImageEditCompare': 'Image A/B Compare',
}
WEB_DIRECTORY = './web'
