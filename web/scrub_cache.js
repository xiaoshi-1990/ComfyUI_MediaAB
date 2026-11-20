import { api } from '../../../scripts/api.js';

export async function prepareScrubCache(clip, signal, progress) {
    const request = async (url, options = {}) => {
        const response = await api.fetchApi(url, {...options, signal});
        if (!response.ok) throw new Error('高清拖动缓存不可用，请重启 ComfyUI 后刷新。');
        return response.json();
    };
    let state = await request('/video_ab/scrub_prepare', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({filename: clip.filename, subfolder: clip.subfolder || '', type: clip.type || 'input'}),
    });
    while (state.status === 'working') {
        progress(state.progress || 0);
        await new Promise((resolve, reject) => {
            const cancel = () => {clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError'));};
            const timer = setTimeout(() => {signal.removeEventListener('abort', cancel); resolve();}, 800);
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();
        });
        state = await request('/video_ab/scrub_status/' + state.key);
    }
    if (state.status !== 'ready') throw new Error(state.message || '高清拖动缓存生成失败。');
    return {...state.proxy, url: api.apiURL('/view?' + new URLSearchParams(state.proxy))};
}
