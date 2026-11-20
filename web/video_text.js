const copy = {
    title: ['Video A/B Compare', '视频A/B对比'],
    video: ['Video {0}', '视频 {0}'],
    select: ['Select video {0}', '选择视频 {0}'], replace: ['Replace video {0}', '替换视频 {0}'],
    selectButton: ['Select {0}', '选择 {0}'], replaceButton: ['Replace {0}', '替换 {0}'],
    mode: ['Comparison mode', '对比模式'], slide: ['Slide Compare', '滑动对比'], side: ['Side by side', '左右并排'], toggle: ['A/B Toggle', 'A/B 切换'],
    show: ['Show video {0}', '显示视频 {0}'], fullscreen: ['Fullscreen', '全屏'], language: ['Switch to Chinese', 'Switch to English'],
    play: ['Play', '播放'], pause: ['Pause', '暂停'], playHint: ['Play or pause both videos', '同步播放或暂停'],
    loop: ['Loop playback', '循环播放'], loopOn: ['Loop on', '循环开'], loopOff: ['Loop off', '循环关'],
    prev: ['Previous frame', '上一帧'], next: ['Next frame', '下一帧'], timeline: ['Video timeline', '同步视频进度'],
    audio: ['Audio track', '监听音轨'], mute: ['Mute', '静音'], listen: ['Listen to {0}', '听视频 {0}'],
    stage: ['Click or press Space to play or pause. Use the arrow keys to step through frames.', '单击或按空格播放或暂停，用方向键逐帧查看。'],
    retry: ['Retry', '重试'], retryHint: ['Reload video previews', '重新读取视频预览'], loading: ['Loading video…', '正在读取视频…'],
    drop: ['Drop to fill video {0}', '松开填入视频 {0}'], dropReplace: ['Drop to replace video {0}', '松开替换视频 {0}'],
    busy: ['Wait for the current import.', '请等待当前视频导入完成。'], one: ['Drop one video at a time.', '请一次拖入一个视频。'],
    fileType: ['Select an MP4, MOV, MKV, WebM, AVI or M4V video.', '请选择 MP4、MOV、MKV、WebM、AVI 或 M4V 视频。'],
    importing: ['Importing {0}…', '正在导入 {0}…'], working: ['Importing…', '正在导入…'], imported: ['Video imported.', '视频已导入。'],
    failed: ['Import failed. {0}', '导入失败。{0}'], readError: ['Could not load video {0}. Select it again or run the node.', '视频 {0} 读取失败，请重新选择或运行节点。'],
    upstream: ['Video {0} is connected. Run the upstream node to preview it.', '视频 {0} 已连接，运行上游后显示。'],
    decode: ['Could not decode video {0}. Try an H.264 MP4 or run the node again.', '视频 {0} 解码失败，请选择 H.264 MP4 或重新运行节点。'],
    fullscreenError: ['Fullscreen is unavailable.', '当前浏览器不允许全屏。'], buffer: ['Waiting for video decoding…', '正在等待视频解码…'],
    seekError: ['Could not seek. Check the video encoding.', '视频定位失败，请检查编码。'], timeout: ['Seeking timed out. Check the video encoding.', '视频定位超时，请检查编码。'],
    playbackError: ['Playback failed. Check the encoding or try muting the audio.', '播放失败，请检查编码或静音后重试。'],
    original: ['Original resolution', '原始分辨率'], scrub: ['HD scrub preview · Release to view original', '高清缓存拖动预览 · 松手恢复原片'],
    cacheWorking: ['Preparing HD scrub cache', '高清拖动缓存准备中'], cacheReady: ['HD scrub cache ready', '高清拖动缓存已就绪'], cacheError: ['Scrub cache unavailable · Using original', '拖动缓存不可用，继续使用原片'],
    localDecode: ['This browser could not read the local video. Try an H.264 MP4.', '浏览器无法读取这段本地视频，请尝试 H.264 MP4。'],
    local: ['Drop a video asset from this ComfyUI instance.', '请拖入本机 ComfyUI 的视频资产。'], assetError: ['Could not read this asset. Select a video file.', '无法读取视频资产，请选择视频文件。'],
    noGraph: ['Add the node to a workflow first.', '请先将节点放入工作流。'], changed: ['The input changed during import. Select the file again.', '导入期间连接或路径已改变，请重新选择。'],
};

export function videoText(language, key, ...args) {
    return (copy[key]?.[language === 'zh' ? 1 : 0] ?? key).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
}
