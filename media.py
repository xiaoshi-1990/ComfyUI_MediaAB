import io
import os
from pathlib import Path
import shutil
import uuid

import av
import folder_paths


EXTENSIONS = {'.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'}


def resolve_video_path(value):
    if not isinstance(value, (str, os.PathLike)):
        raise ValueError('请提供本地视频文件路径。')
    name = os.fspath(value).strip().strip('"')
    if not name or '://' in name:
        raise ValueError('请提供本地视频文件路径。')
    path = Path(name)
    if path.is_absolute():
        path = path.resolve()
    else:
        roots = {'input': folder_paths.get_input_directory(), 'output': folder_paths.get_output_directory(),
                 'temp': folder_paths.get_temp_directory()}
        label, separator, relative = name.replace('\\', '/').partition('/')
        if separator and label in roots:
            root = Path(roots[label]).resolve()
            path = (root / relative).resolve()
            if not path.is_relative_to(root):
                raise ValueError('相对路径超出了所选媒体目录。')
        else:
            path = Path(folder_paths.get_annotated_filepath(name)).resolve()
            if not any(path.is_relative_to(Path(root).resolve()) for root in roots.values()):
                raise ValueError('相对路径超出了媒体目录，请使用完整文件路径。')
    if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
        raise ValueError(f'找不到可读取的视频文件：{path.name}。请选择 MP4、MOV、MKV 或 WebM 等视频格式。')
    return path


def vhs_video_path(value):
    if len(value) != 2 or not isinstance(value[0], bool) or not isinstance(value[1], (list, tuple)):
        raise ValueError('VHS 文件输出格式无效，请连接 Video Combine 的 Filenames。')
    for filename in reversed(value[1]):
        if isinstance(filename, (str, os.PathLike)) and Path(filename).suffix.lower() in EXTENSIONS:
            return resolve_video_path(filename)
    raise ValueError('文件集合中没有视频，请在上游保存为 MP4、WebM 等视频格式。')


def inspect_video(path):
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError(f'文件中没有视频轨道：{Path(path).name}')
        stream = container.streams.video[0]
        audio = container.streams.audio
        duration = float(stream.duration * stream.time_base) if stream.duration is not None else None
        return {
            'codec': stream.codec_context.name, 'width': stream.width, 'height': stream.height,
            'fps': str(stream.average_rate), 'pixel_format': getattr(stream.codec_context.format, 'name', None),
            'duration': duration, 'audio': bool(audio),
            'audio_codec': audio[0].codec_context.name if audio else None,
            'sample_rate': audio[0].codec_context.sample_rate if audio else None,
            'channels': audio[0].codec_context.channels if audio else None,
        }


def preview_file(source):
    source = Path(source).resolve()
    if not source.is_file():
        raise ValueError(f'找不到可预览的视频：{source.name}')
    stat = source.stat()
    metadata = {'fps': inspect_video(source)['fps'], 'version': f'{stat.st_mtime_ns}-{stat.st_size}'}
    for kind, root in [('input', folder_paths.get_input_directory()),
                       ('output', folder_paths.get_output_directory()),
                       ('temp', folder_paths.get_temp_directory())]:
        root = Path(root).resolve()
        if source.is_relative_to(root):
            relative = source.relative_to(root)
            return {'filename': relative.name, 'subfolder': relative.parent.as_posix(), 'type': kind, **metadata}
    root = Path(folder_paths.get_temp_directory()).resolve()
    folder = root / 'video_ab'
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / (uuid.uuid4().hex + source.suffix)
    shutil.copyfile(source, destination)
    relative = destination.relative_to(root)
    return {'filename': relative.name, 'subfolder': relative.parent.as_posix(), 'type': 'temp', **metadata}


def _has_active_trim(video):
    get_window = getattr(video, 'get_active_trim_window', None)
    return callable(get_window) and any(get_window())


def preview_video(video):
    source = video.get_stream_source()
    if isinstance(source, (str, os.PathLike)):
        metadata = inspect_video(source)
        dimensions = video.get_dimensions() if callable(getattr(video, 'get_dimensions', None)) else (metadata['width'], metadata['height'])
        if not _has_active_trim(video) and dimensions == (metadata['width'], metadata['height']):
            return preview_file(source)
    elif not isinstance(source, io.BytesIO):
        raise ValueError('无法读取 VIDEO 的视频内容。')
    folder = Path(folder_paths.get_temp_directory()).resolve() / 'video_ab'
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / (uuid.uuid4().hex + '.mp4')
    try:
        if isinstance(source, io.BytesIO):
            position = source.tell()
            try:
                if _has_active_trim(video):
                    video.save_to(str(destination))
                else:
                    source.seek(0)
                    with destination.open('wb') as output:
                        shutil.copyfileobj(source, output)
            finally:
                source.seek(position)
        else:
            video.save_to(str(destination))
        return {'filename': destination.name, 'subfolder': 'video_ab', 'type': 'temp', 'fps': inspect_video(destination)['fps']}
    except Exception:
        destination.unlink(missing_ok=True)
        raise
