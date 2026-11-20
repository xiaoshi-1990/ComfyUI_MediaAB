from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading

import av
import folder_paths
import imageio_ffmpeg

from .media import EXTENSIONS, inspect_video


KEY = re.compile(r'^[a-f0-9]{40}$')
CACHE_LIMIT = 2 * 1024 ** 3
FILE_LIMIT = 1024 ** 3


class ScrubCache:
    def __init__(self):
        self.jobs = {}
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='media-ab-hd')

    @property
    def root(self):
        return Path(folder_paths.get_temp_directory()).resolve() / 'media_ab_hd'

    @staticmethod
    def source_file(source):
        roots = {'input': folder_paths.get_input_directory(), 'output': folder_paths.get_output_directory(),
                 'temp': folder_paths.get_temp_directory()}
        if not isinstance(source, dict) or source.get('type') not in roots:
            raise ValueError('请选择本地视频。')
        filename, subfolder = source.get('filename'), source.get('subfolder', '')
        if not isinstance(filename, str) or not isinstance(subfolder, str):
            raise ValueError('视频文件名或目录无效。')
        root = Path(roots[source['type']]).resolve()
        path = (root / subfolder / filename).resolve()
        if not path.is_relative_to(root) or path.suffix.lower() not in EXTENSIONS or not path.is_file():
            raise ValueError('视频文件不存在或路径无效。')
        return path

    @staticmethod
    def fingerprint(path):
        stat = path.stat()
        return hashlib.sha256(f'hd-1\n{path}\n{stat.st_size}\n{stat.st_mtime_ns}'.encode()).hexdigest()[:40]

    def descriptor(self, key):
        return {'filename': key + '.mp4', 'subfolder': 'media_ab_hd', 'type': 'temp'}

    def prepare(self, source):
        path = self.source_file(source)
        key = self.fingerprint(path)
        with self.lock:
            cached = self.root / (key + '.mp4')
            if cached.is_file():
                os.utime(cached, None)
                return {'key': key, 'status': 'ready', 'progress': 1, 'cache_hit': True, 'proxy': self.descriptor(key)}
            if key in self.jobs and self.jobs[key]['status'] == 'working':
                return dict(self.jobs[key])
            if sum(job['status'] == 'working' for job in self.jobs.values()) >= 32:
                raise ValueError('正在准备的缓存较多，请稍后重试。')
            self.jobs[key] = {'key': key, 'status': 'working', 'progress': 0, 'proxy': None}
            for old in list(self.jobs):
                if len(self.jobs) <= 64:
                    break
                if self.jobs[old]['status'] != 'working':
                    del self.jobs[old]
            self.worker.submit(self.build, key, path)
            return dict(self.jobs[key])

    def status(self, key):
        with self.lock:
            state = self.jobs.get(key) if KEY.fullmatch(key) else None
            return dict(state) if state else None

    def update(self, key, **values):
        with self.lock:
            self.jobs[key].update(values)

    def build(self, key, path):
        temporary = self.root / (key + '.partial.mp4')
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            if self.fingerprint(path) != key:
                raise ValueError('素材已改变，请重新选择视频。')
            metadata = inspect_video(path)
            duration = float(metadata['duration'] or 0)
            command = [imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-nostdin', '-y',
                       '-threads', '2', '-filter_threads', '1', '-copyts', '-i', str(path),
                       '-map', '0:v:0', '-an', '-sn', '-dn',
                       '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black',
                       '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
                       '-crf', '15', '-pix_fmt', 'yuv420p', '-g', '1', '-keyint_min', '1',
                       '-sc_threshold', '0', '-bf', '0', '-threads', '2',
                       '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux',
                       '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', str(temporary)]
            with tempfile.TemporaryFile() as errors:
                with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors,
                                      creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as process:
                    try:
                        for line in process.stdout:
                            if line.startswith(b'out_time_us='):
                                value = line.partition(b'=')[2].strip()
                                if value.lstrip(b'-').isdigit() and duration > 0:
                                    self.update(key, progress=max(0, min(.99, int(value) / 1_000_000 / duration)))
                                if temporary.exists() and temporary.stat().st_size > FILE_LIMIT:
                                    raise ValueError('单个高清缓存超过1GB，继续使用原片拖动。')
                        process.wait()
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=3)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
                    if process.returncode:
                        errors.seek(0, os.SEEK_END)
                        errors.seek(max(0, errors.tell() - 1200))
                        raise RuntimeError(errors.read().decode('utf-8', errors='replace'))
            if self.fingerprint(path) != key:
                raise ValueError('素材已改变，请重新选择视频。')
            if temporary.stat().st_size > FILE_LIMIT:
                raise ValueError('单个高清缓存超过1GB，继续使用原片拖动。')
            temporary.replace(self.root / (key + '.mp4'))
            self.update(key, status='ready', progress=1, cache_hit=False, proxy=self.descriptor(key))
            self.cleanup(key)
        except (ValueError, OSError, RuntimeError, av.error.FFmpegError) as error:
            self.update(key, status='error', message=str(error))
        finally:
            temporary.unlink(missing_ok=True)

    def cleanup(self, keep):
        files = sorted((path for path in self.root.glob('*.mp4') if KEY.fullmatch(path.stem)),
                       key=lambda path: path.stat().st_mtime, reverse=True)
        size = 0
        for path in files:
            size += path.stat().st_size
            if size > CACHE_LIMIT and path.stem != keep:
                path.unlink(missing_ok=True)
