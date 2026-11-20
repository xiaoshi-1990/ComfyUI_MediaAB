import { panelLanguage } from './panel_language.js';
import { videoText } from './video_text.js';
import { createSourceInfo } from './source_info.js';
import { app } from '../../../scripts/app.js';
import { applyAppearance } from './appearance.js';

export function canvasWheel(root) {
    let drag = null;
    const end = () => {
        if (drag && root.hasPointerCapture(drag.id)) root.releasePointerCapture(drag.id);
        drag = null;
    };
    const down = event => {
        if (event.button !== 1 || document.fullscreenElement?.contains(root) || event.target.closest('input, select, textarea')) return;
        const canvas = app.canvas;
        if (!canvas?.graph || !canvas.allow_dragcanvas) return;
        drag = {id: event.pointerId, x: event.clientX, y: event.clientY, canvas};
        root.setPointerCapture(event.pointerId);
        event.preventDefault(); event.stopPropagation();
    };
    const move = event => {
        if (!drag || event.pointerId !== drag.id) return;
        const {canvas} = drag;
        canvas.ds.offset[0] += (event.clientX - drag.x) / canvas.ds.scale;
        canvas.ds.offset[1] += (event.clientY - drag.y) / canvas.ds.scale;
        drag.x = event.clientX; drag.y = event.clientY;
        canvas.setDirty(true, true);
        event.preventDefault(); event.stopPropagation();
    };
    const up = event => {
        if (!drag || event.pointerId !== drag.id) return;
        end(); event.preventDefault(); event.stopPropagation();
    };
    const wheel = event => {
        if (document.fullscreenElement?.contains(root) || event.target.closest('input, select, textarea')) return;
        const canvas = app.canvas;
        if (!canvas?.graph || !canvas.allow_dragcanvas) return;
        canvas.processMouseWheel(event);
        event.stopPropagation();
    };
    root.addEventListener('wheel', wheel, {passive: false});
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('lostpointercapture', end);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', end);
    return () => {
        end(); root.removeEventListener('wheel', wheel);
        root.removeEventListener('pointerdown', down, {capture: true});
        root.removeEventListener('lostpointercapture', end);
        window.removeEventListener('pointermove', move, {capture: true});
        window.removeEventListener('pointerup', up, {capture: true});
        window.removeEventListener('pointercancel', up, {capture: true});
        window.removeEventListener('blur', end);
    };
}

export function mouseDivider(screen, pane, divider, enabled) {
    let split = 50, frame = 0;
    let host = null;
    function fitStroke() {
        if (!enabled() || !screen.offsetWidth) return;
        const width = screen.getBoundingClientRect().width;
        if (width > 0) divider.style.transform = `scaleX(${screen.offsetWidth / width})`;
    }
    // Canvas zoom transforms the widget host without resizing its content box.
    const zoomObserver = new MutationObserver(fitStroke);
    const resizeObserver = new ResizeObserver(() => {
        const nextHost = screen.closest('.dom-widget');
        if (host !== nextHost) {
            zoomObserver.disconnect();
            host = nextHost;
            if (host) zoomObserver.observe(host, {attributes:true, attributeFilter:['style']});
        }
        fitStroke();
    });
    resizeObserver.observe(screen);
    document.addEventListener('fullscreenchange', fitStroke);
    const paint = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        pane.style.clipPath = enabled() ? `inset(0 0 0 ${split}%)` : '';
        divider.style.left = `${split}%`;
        divider.style.display = enabled() ? '' : 'none';
    };
    const move = event => {
        if (!enabled() || event.buttons & 4) return;
        const rect = screen.getBoundingClientRect();
        split = Math.max(0, Math.min(100, (event.clientX - rect.left) / Math.max(1, rect.width) * 100));
        if (!frame) frame = requestAnimationFrame(paint);
    };
    screen.addEventListener('pointermove', move);
    screen.addEventListener('pointerdown', move);
    return {
        paint() {paint(); fitStroke();},
        dispose() {
            cancelAnimationFrame(frame);
            zoomObserver.disconnect();
            resizeObserver.disconnect();
            document.removeEventListener('fullscreenchange', fitStroke);
            screen.removeEventListener('pointermove', move);
            screen.removeEventListener('pointerdown', move);
        },
    };
}

// The asset panel may put the relative path in display_name and only the basename in filename.
export const isVideoFilename = name => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name || '');

function assetFile(path, type) {
    if (typeof path !== 'string' || !['input', 'output', 'temp'].includes(type)) throw new Error('assetError');
    const parts = path.replaceAll('\\', '/').split('/');
    if (parts.some(part => !part || part === '..' || part === '.' || part.includes(':'))) throw new Error('assetError');
    const filename = parts.pop();
    if (!isVideoFilename(filename)) throw new Error('fileType');
    return {filename, subfolder:parts.join('/'), type};
}

export function droppedVideos(data) {
    const raw = data?.getData?.('application/x-comfy-asset-info');
    if (!raw && data?.files?.length) return [...data.files];
    const asset = raw ? JSON.parse(raw) : {};
    if (asset.media_kind && asset.media_kind !== 'video') throw new Error('fileType');
    const uri = data?.getData?.('text/uri-list')?.split(/[\r\n]+/).find(line => line && !line.startsWith('#'));
    const urls = [asset.media_url, uri, asset.preview_url].filter(Boolean).map(value => new URL(value, location.href));
    if (urls.some(url => url.origin !== location.origin)) throw new Error('local');
    for (const url of urls) {
        const params = url.searchParams;
        const name = params.get('filename');
        if (/\/view$/.test(url.pathname) && isVideoFilename(name)) {
            const folder = params.get('subfolder');
            return [assetFile(folder && folder !== '.' ? `${folder}/${name}` : name, params.get('type') || asset.type || 'input')];
        }
    }
    const name = asset.filename?.replaceAll('\\', '/');
    const type = asset.type || 'input';
    if (asset.subfolder && asset.subfolder !== '.') return [assetFile(`${asset.subfolder}/${name}`, type)];
    if (name?.includes('/')) return [assetFile(name, type)];
    const display = asset.display_name?.replaceAll('\\', '/');
    if (name && display?.endsWith('/' + name)) return [assetFile(display, type)];
    // Newer asset panels expose a content URL, with no filesystem path in its query.
    for (const url of urls) {
        const match = url.pathname.match(/\/assets\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/content$/i);
        if (match) return [{assetId:match[1], filename:name}];
    }
    return [assetFile(name, type)];
}

export function assetDetailFile(detail) {
    const type = detail.tags?.find(tag => ['input', 'output', 'temp'].includes(tag));
    return assetFile(detail.loader_path || detail.display_name || detail.name, type);
}

export function mediaDropIndex(root, buttons, isOccupied, event, canvasSide) {
    const buttonIndex = buttons.indexOf(event.target?.closest?.('button[data-side]'));
    if (buttonIndex >= 0) return buttonIndex;
    const empty = [0, 1].find(i => !isOccupied(i));
    if (empty !== undefined) return empty;
    if (canvasSide !== undefined) return canvasSide;
    const rect = root.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 0 : 1;
}

export function createABPlayer(clips, {onResize = () => {}, onSelectFile = null, isOccupied = i => Boolean(clips?.[i]), prepareScrubCache = null, preferences = {}, onPreference = () => {}, onRetry = null} = {}) {
    let language = panelLanguage(preferences.language);
    const t = (key, ...args) => videoText(language, key, ...args);
    const bindings = [];
    function bind(render) {bindings.push(render); render();}
    function hint(el, label) {el.title = label; el.setAttribute('aria-label', label);}
    const feedback = [null, null];
    const sources = [clips?.[0] || null, clips?.[1] || null];
    const canSelect = typeof onSelectFile === 'function';
    const root = document.createElement('div');
    root.className = 'media-ab ve-ab-player';
    const removeWheel = canvasWheel(root);
    let showB = preferences.showB === true, active = false, disposed = false, frame = 0, duration = 0, syncing = false, buffering = false;
    let looping = preferences.loop !== false, pendingIndex = null, playRequest = 0, lastCorrection = 0;
    let scrubbing = false, scrubTime = 0, resumeAfterScrub = false, scrubVersion = 0;
    let seekTarget = null, seekTask = null, scrubFrame = 0;
    const scrubTargets = [null, null], scrubTasks = [null, null], scrubCancels = [null, null];
    const presented = [null, null], frameCallbacks = [null, null], seekCancels = new Set();
    const snapshots = [];
    const cacheAbort = new AbortController(), cacheVideos = [null, null];
    const cacheStates = sources.map(clip => ({status: prepareScrubCache && clip?.url && !clip.local ? 'working' : 'off', progress: 0}));
    let dragVideos = [];
    let haveStills = false;
    const fps = sources.map(clip => {
        const [n, d = '1'] = String(clip?.fps ?? '').split('/');
        const value = Number(n) / Number(d);
        return Number.isFinite(value) && value > 0 ? value : null;
    });
    const failures = [false, false];
    const selectButtons = [], importStatuses = [];
    const configured = () => videos.filter((_, i) => !!sources[i]?.url && !failures[i]);
    const masterRate = () => fps[videos.indexOf(configured()[0])];
    const ready = () => configured().filter(v => Number.isFinite(v.duration) && v.duration > 0);
    const button = (text, label, action) => {
        const el = document.createElement('button');
        el.type = 'button'; bind(() => {el.textContent = t(text); hint(el, t(label));});
        el.onclick = action; return el;
    };
    function importFeedback(index, message, kind = '') {
        if (disposed) return;
        feedback[index] = typeof message === 'function' ? message : () => t(message);
        importStatuses[index].textContent = feedback[index]();
        importStatuses[index].dataset.kind = kind;
        onResize();
    }
    function busy(value) {
        selectButtons.forEach((card, i) => {
            card.disabled = value;
            card.classList.toggle('ve-uploading', value && i === pendingIndex);
            card.setAttribute('aria-busy', String(value && i === pendingIndex));
        });
        play.disabled = value || duration <= 0;
        timeline.disabled = value || duration <= 0;
        previous.disabled = next.disabled = value || duration <= 0 || !masterRate();
    }
    async function selectFiles(index, files) {
        if (!canSelect || disposed) return;
        if (pendingIndex !== null) {
            importFeedback(index, 'busy'); return;
        }
        if (!files?.length) return;
        if (files.length !== 1) {
            importFeedback(index, 'one', 'error'); return;
        }
        const file = files[0];
        if (!file.assetId && !isVideoFilename(file.name || file.filename)) {
            importFeedback(index, 'fileType', 'error'); return;
        }
        pause(); pendingIndex = index; busy(true);
        importFeedback(index, () => t('importing', file.name || file.filename || (index ? 'B' : 'A')));
        try {
            await onSelectFile(index, file);
            if (!disposed) importFeedback(index, 'imported', 'success');
        } catch (error) {
            if (!disposed) importFeedback(index, () => t('failed', errorText(error, index)), 'error');
        } finally {
            if (!disposed) {pendingIndex = null; busy(false);}
        }
    }
    function errorText(error, index) {
        const message = error?.message || '';
        return message && !(language === 'en' && /[\p{Script=Han}]/u.test(message)) ? t(message) : t('readError', index ? 'B' : 'A');
    }
    function clearDrop() {
        delete root.dataset.dropHint;
        delete root.dataset.replaceSide;
    }
    function handleDragOver(event, canvasSide) {
        if (!canSelect || disposed) return false;
        event.preventDefault(); event.stopPropagation();
        const index = mediaDropIndex(root, selectButtons, isOccupied, event, canvasSide);
        const side = index ? 'B' : 'A';
        const replacing = isOccupied(index);
        if (replacing && pendingIndex === null) root.dataset.replaceSide = side;
        else delete root.dataset.replaceSide;
        root.dataset.dropHint = pendingIndex !== null ? t('working') : t(replacing ? 'dropReplace' : 'drop', side);
        event.dataTransfer.dropEffect = pendingIndex === null ? 'copy' : 'none';
        return true;
    }
    function handleDrop(event, canvasSide) {
        if (!canSelect || disposed) return false;
        event.preventDefault(); event.stopPropagation(); clearDrop();
        if (pendingIndex !== null) {
            importFeedback(pendingIndex, 'busy');
            return true;
        }
        const index = mediaDropIndex(root, selectButtons, isOccupied, event, canvasSide);
        try {void selectFiles(index, droppedVideos(event.dataTransfer));}
        catch (error) {importFeedback(index, () => errorText(error, index), 'error');}
        return true;
    }
    const controls = document.createElement('div'); controls.className = 'media-ab-toolbar';
    const notices = document.createElement('div'); notices.className = 've-notices';
    sources.forEach((clip, i) => {
        const letter = i ? 'B' : 'A';
        const feedback = document.createElement('div'); feedback.className = 've-import-status';
        feedback.setAttribute('role', 'status'); notices.append(feedback); importStatuses.push(feedback);
        if (!canSelect) return;
        const input = document.createElement('input'); input.type = 'file'; input.accept = 'video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v'; input.hidden = true;
        input.onchange = () => {const files = [...input.files]; input.value = ''; void selectFiles(i, files);};
        const choose = button('', '', () => input.click());
        bind(() => updatePicker(choose, i));
        choose.dataset.side = letter; selectButtons.push(choose);
        controls.append(choose, input);
    });
    function updatePicker(choose, i) {
        const action = isOccupied(i) ? 'replace' : 'select';
        const side = i ? 'B' : 'A';
        choose.textContent = t(`${action}Button`, side);
        hint(choose, t(action, side));
        if (sources[i]?.filename) choose.title += ' · ' + sources[i].filename;
    }
    function option(select, value, key, ...args) {
        const item = new Option('', value);
        bind(() => {item.textContent = t(key, ...args);});
        select.add(item); return item;
    }
    const retry = button('retry', 'retryHint', () => onRetry?.()); retry.hidden = true;
    notices.append(retry);
    const mode = document.createElement('select'); bind(() => hint(mode, t('mode')));
    for (const key of ['slide', 'side', 'toggle']) option(mode, key, key);
    mode.value = ['side','toggle'].includes(preferences.mode) ? preferences.mode : 'slide';
    const toggle = button('', '', () => {showB = !showB; onPreference('showB', showB); layout();});
    const screen = document.createElement('div');
    screen.className = 'media-ab-stage'; screen.tabIndex = 0;
    const panes = sources.map(() => {
        const el = document.createElement('div'); el.style.cssText = 'position:absolute;inset:0;'; return el;
    });
    const videos = sources.map((clip, i) => {
        const video = document.createElement('video');
        video.className = 've-original';
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        if (clip?.url) video.src = clip.url;
        const still = document.createElement('canvas'); still.className = 've-still';
        still.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;pointer-events:none';
        snapshots.push(still);
        panes[i].append(video, still); screen.append(panes[i]); return video;
    });
    const divider = document.createElement('div');
    divider.className = 'media-ab-divider';
    screen.append(divider);
    const splitControl = mouseDivider(screen, panes[1], divider, () => mode.value === 'slide' && configured().length === 2);
    const transport = document.createElement('div'); transport.className = 'media-ab-transport';
    const timeline = document.createElement('input'); timeline.type = 'range'; timeline.min = '0'; timeline.max = '0'; timeline.step = '0.001'; timeline.value = '0'; timeline.disabled = true;
    bind(() => hint(timeline, t('timeline'))); timeline.style.flex = '1';
    const clock = document.createElement('span'); clock.style.cssText = 'font-variant-numeric:tabular-nums;white-space:nowrap';
    const status = document.createElement('div'); status.className = 've-playback-status media-ab-info'; status.setAttribute('role', 'status');
    let statusText = () => configured().length ? t('loading') : '';
    function setStatus(render) {statusText = render; status.textContent = render();}
    bind(() => {status.textContent = statusText();});
    const play = button('play', 'playHint', () => active ? pauseAtFrame() : void start()); play.disabled = true;
    screen.addEventListener('click', event => {
        if (event.button !== 0 || event.target.closest('button') || scrubbing) return;
        event.stopPropagation(); play.click();
    });
    const loop = button('loopOn', 'loop', () => {looping = !looping; onPreference('loop', looping); loop.textContent = t(looping ? 'loopOn' : 'loopOff'); loop.setAttribute('aria-pressed', String(looping));});
    loop.textContent = t(looping ? 'loopOn' : 'loopOff'); loop.setAttribute('aria-pressed', String(looping));
    const audio = document.createElement('select'); bind(() => hint(audio, t('audio')));
    option(audio, 'mute', 'mute');
    option(audio, 'a', 'listen', 'A').disabled = !sources[0]?.url;
    option(audio, 'b', 'listen', 'B').disabled = !sources[1]?.url;
    audio.onchange = () => {videos[0].muted = audio.value !== 'a'; videos[1].muted = audio.value !== 'b';};
    const fullscreen = button('⛶', 'fullscreen', () => {(document.fullscreenElement === root ? document.exitFullscreen() : root.requestFullscreen?.())?.catch(() => {if (!disposed) setStatus(() => t('fullscreenError'));});});
    const locale = button('', 'language', () => {
        setLanguage(language === 'en' ? 'zh' : 'en');
        onPreference('language', language);
    });
    function setLanguage(next) {
        if (next === language) return;
        language = next;
        bindings.forEach(render => render());
        feedback.forEach((render, i) => {if (render) importStatuses[i].textContent = render();});
        layout();
    }
    locale.className = 'video-ab-language';
    controls.append(mode, toggle, audio, fullscreen, locale);
    applyAppearance(root);
    const previous = button('‹', 'prev', () => stepFrame(-1));
    const next = button('›', 'next', () => stepFrame(1));
    transport.append(play, previous, next, loop, timeline, clock);
    const sourceInfo = createSourceInfo();
    root.append(sourceInfo.element, screen, controls, transport, notices, status);
    function layout() {
        if (disposed) return;
        const count = configured().length, both = count === 2;
        const side = both && mode.value === 'side', split = both && mode.value === 'slide';
        screen.hidden = transport.hidden = audio.hidden = fullscreen.hidden = status.hidden = count === 0;
        mode.hidden = !both;
        root.lang = language === 'zh' ? 'zh-CN' : 'en';
        locale.textContent = language === 'zh' ? '中' : 'EN';
        screen.title = t(masterRate() ? 'stage' : 'playHint');
        play.textContent = t(active ? 'pause' : 'play');
        loop.textContent = t(looping ? 'loopOn' : 'loopOff');
        panes[0].style.cssText = `position:absolute;inset:0;${side ? 'right:50%;' : ''}`;
        panes[1].style.cssText = `position:absolute;inset:0;${side ? 'left:50%;' : ''}`;
        panes.forEach((pane, i) => {pane.hidden = !sources[i]?.url || failures[i] || (both && !side && !split && i !== Number(showB));});
        videos.forEach((video, i) => {
            const durationText = Number.isFinite(video.duration) ? `${video.duration.toFixed(2)} s` : '';
            sourceInfo.update(i, failures[i] ? 0 : video.videoWidth, video.videoHeight, sources[i]?.filename, durationText);
        });
        splitControl.paint();
        toggle.style.display = both && mode.value === 'toggle' ? '' : 'none';
        toggle.textContent = t('show', showB ? 'A' : 'B'); hint(toggle, toggle.textContent);
        const ref = ready()[0];
        const ratio = ref?.videoWidth && ref?.videoHeight ? ref.videoWidth / ref.videoHeight : 16 / 9;
        screen.style.aspectRatio = String(side ? ratio * 2 : ratio);
        onResize();
    }
    function paint() {
        if (disposed) return;
        const master = configured()[0], index = videos.indexOf(master);
        const time = scrubbing || seekTask ? scrubTime : (active ? presented[index] : null) ?? master?.currentTime ?? 0;
        timeline.value = String(time);
        clock.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)}s`;
    }
    function stopFrames() {
        cancelAnimationFrame(frame); frame = 0;
        videos.forEach((video, i) => {
            if (frameCallbacks[i] !== null) video.cancelVideoFrameCallback?.(frameCallbacks[i]);
            frameCallbacks[i] = null;
        });
    }
    function captureFrames(frames = videos) {
        const loaded = frames.filter((_, i) => sources[i]?.url && !failures[i]);
        if (disposed || !loaded.length || loaded.some(v => v.readyState < 2)) return;
        frames.forEach((video, i) => {
            if (failures[i] || !sources[i]?.url || !video.videoWidth) return;
            const still = snapshots[i];
            if (still.width !== video.videoWidth) still.width = video.videoWidth;
            if (still.height !== video.videoHeight) still.height = video.videoHeight;
            still.getContext('2d', {alpha: false}).drawImage(video, 0, 0);
            still.style.display = 'block';
        });
        haveStills = true;
    }
    function displayedVideos() {
        return videos.map((video, i) => cacheVideos[i]?.style.display === 'block' ? cacheVideos[i] : video);
    }
    function showOriginals() {
        videos.forEach((video, i) => {
            video.style.visibility = '';
            if (cacheVideos[i]) cacheVideos[i].style.display = 'none';
        });
    }
    function cacheStatus() {
        const states = cacheStates.filter(s => s.status !== 'off');
        const state = !prepareScrubCache || !states.length ? 'off' : states.some(s => s.status === 'error') ? 'error' : states.every(s => s.status === 'ready') ? 'ready' : 'working';
        status.dataset.scrubCache = state;
        if (!duration) return;
        setStatus(() => {
            let detail = t('original');
            if (scrubbing && displayedVideos().some((video, i) => video !== videos[i])) detail = t('scrub');
            else if (state === 'working') {
                const progress = cacheStates.flatMap((s, i) => s.status !== 'off' ? [`${i ? 'B' : 'A'} ${s.status === 'ready' ? 100 : Math.round(s.progress * 100)}%`] : []);
                detail += ' · ' + t('cacheWorking') + ' ' + progress.join(' / ');
            } else if (state === 'ready' || state === 'error') detail += ' · ' + t(state === 'ready' ? 'cacheReady' : 'cacheError');
            if (!masterRate()) detail += language === 'zh' ? ' · 无法确认固定帧率，逐帧功能不可用' : ' · Frame stepping unavailable: constant frame rate unknown';
            return detail;
        });
    }
    function cacheFailed(index) {
        if (disposed) return;
        cacheStates[index].status = 'error';
        const cached = cacheVideos[index];
        if (cached) cached.style.display = 'none';
        videos[index].style.visibility = '';
        if (dragVideos[index] === cached) {
            scrubCancels[index]?.(); dragVideos[index] = videos[index];
            if (scrubbing) queueMicrotask(() => void previewScrub());
        }
        cacheStatus();
    }
    async function prepareCache(index) {
        try {
            const proxy = await prepareScrubCache(sources[index], cacheAbort.signal, progress => {
                if (disposed) return;
                cacheStates[index].progress = progress; cacheStatus();
            });
            if (disposed) return;
            const video = document.createElement('video');
            video.className = 've-scrub-video'; video.muted = true; video.playsInline = true; video.preload = 'auto';
            video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;pointer-events:none';
            video.addEventListener('loadeddata', () => {
                if (disposed) return;
                cacheStates[index] = {status: 'ready', progress: 1}; cacheStatus();
            }, {once: true});
            video.addEventListener('error', () => cacheFailed(index));
            cacheVideos[index] = video; panes[index].insertBefore(video, snapshots[index]);
            video.src = proxy.url; video.load();
        } catch {
            if (!disposed) cacheFailed(index);
        }
    }
    function pause() {
        playRequest++; active = false; buffering = false; stopFrames();
        videos.forEach(v => {v.pause(); v.playbackRate = 1;}); play.textContent = t('play'); paint();
    }
    function watchFrames() {
        const loaded = configured();
        const watch = (video, index) => {
            if (!active || disposed || buffering || frameCallbacks[index] !== null || !video.requestVideoFrameCallback) return;
            frameCallbacks[index] = video.requestVideoFrameCallback((now, metadata) => {
                frameCallbacks[index] = null;
                if (!active || disposed || buffering) return;
                presented[index] = metadata.mediaTime;
                scheduleTick(); watch(video, index);
            });
        };
        loaded.forEach(video => watch(video, videos.indexOf(video)));
        if (!loaded[0]?.requestVideoFrameCallback) scheduleTick();
    }
    function scheduleTick() {
        if (!disposed && active && !buffering && !frame) frame = requestAnimationFrame(() => {frame = 0; void tick();});
    }
    function seekVideo(video, time, preview = false) {
        const index = videos.includes(video) ? videos.indexOf(video) : cacheVideos.indexOf(video);
        if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < .000001) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let finished = false;
            const complete = error => {
                if (finished) return;
                finished = true; clearTimeout(timer);
                video.removeEventListener('seeked', decoded); video.removeEventListener('loadeddata', decoded); video.removeEventListener('error', failed);
                seekCancels.delete(cancel);
                if (scrubCancels[index] === cancel) scrubCancels[index] = null;
                error ? reject(error) : resolve();
            };
            const cancel = () => complete();
            const failed = () => complete(new Error('seekError'));
            const decoded = () => {
                if (video.seeking || video.readyState < 2) return;
                presented[index] = null;
                complete();
            };
            const timer = setTimeout(() => complete(new Error('timeout')), 5000);
            seekCancels.add(cancel);
            if (preview) scrubCancels[index] = cancel;
            video.addEventListener('seeked', decoded); video.addEventListener('loadeddata', decoded); video.addEventListener('error', failed, {once: true});
            try {
                if (preview && video.fastSeek) video.fastSeek(time);
                else video.currentTime = time;
            } catch (error) {complete(error);}
        });
    }
    async function seek(time) {
        const t = Math.max(0, Math.min(time, Math.max(0, duration - .00001)));
        if (!snapshots.some(canvas => canvas.style.display === 'block')) {
            const frames = displayedVideos(); captureFrames(frames);
            if (haveStills && frames.every((video, i) => !sources[i]?.url || video.readyState >= 2 || video === videos[i])) snapshots.forEach((canvas, i) => {if (sources[i]?.url) canvas.style.display = 'block';});
        }
        await Promise.all(ready().map(video => {
            const rate = fps[videos.indexOf(video)];
            if (!rate) return seekVideo(video, t);
            const boundary = Math.round(t * rate) / rate;
            const target = Math.abs(t - boundary) < .000001 ? Math.min(t + .00001, Math.max(0, duration - .00001)) : t;
            return seekVideo(video, target);
        }));
        if (disposed) return;
        captureFrames(); showOriginals(); cacheStatus(); paint();
    }
    async function start() {
        if (!duration || disposed || scrubbing || pendingIndex !== null) return;
        const request = ++playRequest;
        try {
            if (seekTask) await seekTask;
            const master = ready()[0]; if (!master) return;
            await seek(master.currentTime >= duration - .01 ? 0 : master.currentTime);
            if (disposed || request !== playRequest || pendingIndex !== null) return;
            await playVideos(request);
        } catch (error) {
            if (!disposed && request === playRequest) {pause(); setStatus(() => t(error.message || 'playbackError'));}
        }
    }
    async function playVideos(request) {
        active = true; buffering = false; play.textContent = t('pause');
        await Promise.all(configured().map(v => v.play()));
        if (disposed || !active || buffering || request !== playRequest) return;
        snapshots.forEach(canvas => {canvas.style.display = 'none';});
        watchFrames();
    }
    function locate(time) {
        seekTarget = scrubTime = Math.max(0, Math.min(time, Math.max(0, duration - .00001)));
        paint(); return flushSeek();
    }
    function pauseAtFrame() {
        const time = configured()[0]?.currentTime || 0;
        pause(); void locate(time);
    }
    function stepFrame(direction) {
        const rate = masterRate();
        if (!rate || !duration || disposed || pendingIndex !== null) return;
        const master = configured()[0];
        const time = scrubbing || seekTask ? scrubTime : (active ? presented[videos.indexOf(master)] : null) ?? master.currentTime;
        pause(); scrubbing = false; scrubVersion++; stopScrubPreviews();
        const nextFrame = Math.floor(time * rate + .0001) + direction;
        void locate(Math.max(0, nextFrame / rate));
    }
    function beginScrub() {
        if (scrubbing || !duration || disposed) return;
        scrubbing = true; scrubVersion++; scrubTime = Number(timeline.value);
        resumeAfterScrub = active; pause(); captureFrames();
        dragVideos = videos.map((video, i) => cacheStates[i].status === 'ready' && cacheVideos[i]?.readyState >= 2 ? cacheVideos[i] : video);
        snapshots.forEach(canvas => {canvas.style.display = 'none';});
    }
    function stopScrubPreviews() {
        cancelAnimationFrame(scrubFrame); scrubFrame = 0; scrubTargets.fill(null);
        scrubCancels.forEach(cancel => cancel?.());
    }
    async function previewScrub() {
        cancelAnimationFrame(scrubFrame); scrubFrame = 0;
        const version = scrubVersion;
        if (seekTask) await seekTask;
        if (disposed || !scrubbing || version !== scrubVersion) return;
        ready().forEach(original => {
            const i = videos.indexOf(original);
            scrubTargets[i] = Math.max(0, Math.min(scrubTime, duration - .00001));
            if (scrubTasks[i]) return;
            scrubTasks[i] = (async () => {
                while (scrubbing && !disposed && version === scrubVersion && scrubTargets[i] !== null) {
                    const target = scrubTargets[i]; scrubTargets[i] = null;
                    const video = dragVideos[i] || original;
                    await seekVideo(video, target, true);
                    if (scrubbing && !disposed && version === scrubVersion && video === cacheVideos[i] && dragVideos[i] === video) {
                        original.style.visibility = 'hidden'; video.style.display = 'block'; cacheStatus();
                    }
                }
            })().catch(error => {
                if (!disposed && version === scrubVersion) setStatus(() => t(error.message));
            }).finally(() => {scrubTasks[i] = null;});
        });
    }
    function flushSeek() {
        cancelAnimationFrame(scrubFrame); scrubFrame = 0;
        if (seekTask) return seekTask;
        seekTask = (async () => {
            await Promise.all(scrubTasks.filter(Boolean));
            while (seekTarget !== null && !disposed) {
                const target = seekTarget; seekTarget = null;
                await seek(target);
            }
        })().catch(error => {
            seekTarget = null;
            if (!disposed) {pause(); setStatus(() => t(error.message));}
        }).finally(() => {seekTask = null; if (!disposed) paint();});
        return seekTask;
    }
    async function finishScrub() {
        if (!scrubbing) return;
        const version = scrubVersion, resume = resumeAfterScrub;
        scrubbing = false; stopScrubPreviews();
        // Commit the final pointer position before resuming playback.
        seekTarget = scrubTime;
        await flushSeek();
        if (disposed || version !== scrubVersion || scrubbing) return;
        paint();
        if (resume) await start();
    }
    timeline.addEventListener('pointerdown', event => {
        beginScrub(); timeline.setPointerCapture?.(event.pointerId);
    });
    timeline.addEventListener('pointerup', () => void finishScrub());
    timeline.addEventListener('pointercancel', () => void finishScrub());
    timeline.addEventListener('change', () => void finishScrub());
    timeline.addEventListener('blur', () => void finishScrub());
    timeline.oninput = () => {
        const target = Number(timeline.value);
        beginScrub(); scrubTime = target; paint();
        if (!scrubFrame) scrubFrame = requestAnimationFrame(() => void previewScrub());
    };
    mode.onchange = () => {onPreference('mode', mode.value); layout();};
    screen.addEventListener('keydown', event => {
        if (event.code === 'Space' || ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault();
            if (event.code === 'Space') play.click();
            else stepFrame(event.key === 'ArrowLeft' ? -1 : 1);
        }
    });
    function metadata() {
        if (disposed) return;
        const loaded = configured();
        if (!loaded.length || ready().length !== loaded.length) {layout(); return;}
        duration = Math.min(...loaded.map(v => v.duration)); timeline.max = String(duration); busy(pendingIndex !== null);
        cacheStatus();
        layout(); paint();
    }
    videos.forEach((v, i) => {
        v.addEventListener('loadedmetadata', metadata);
        v.addEventListener('ended', () => {if (active && !buffering) void tick();});
        v.addEventListener('waiting', () => {
            if (!active || scrubbing || syncing || v.seeking || v.ended) return;
            buffering = true; stopFrames(); captureFrames();
            configured().forEach(video => {video.pause(); video.playbackRate = 1;});
            setStatus(() => t('buffer'));
            queueMicrotask(resumeBuffered);
        });
        v.addEventListener('canplay', resumeBuffered);
        v.addEventListener('error', () => {
            if (disposed || !sources[i]?.url) return;
            failures[i] = true; retry.hidden = !onRetry; pause(); duration = 0; layout(); metadata(); busy(pendingIndex !== null);
            importFeedback(i, () => t('decode', i ? 'B' : 'A'), 'error');
        });
    });
    function resumeBuffered() {
        if (disposed || !active || !buffering || configured().some(v => v.readyState < 3 || v.seeking)) return;
        buffering = false; metadata();
        const request = ++playRequest;
        void playVideos(request).catch(error => {
            if (!disposed && request === playRequest) {pause(); setStatus(() => t(error.message));}
        });
    }
    async function tick() {
        if (disposed) return;
        if (active && !buffering && !syncing) {
            const loaded = configured(); const master = loaded[0];
            if (master && (master.currentTime >= duration - 0.03 || loaded.some(v => v.ended))) {
                pause();
                if (looping) {
                    const request = playRequest;
                    syncing = true;
                    try {await seek(0); if (!disposed && request === playRequest) await start();}
                    catch (error) {if (!disposed) setStatus(() => t(error.message));}
                    finally {syncing = false;}
                }
            } else if (loaded.length === 2 && loaded.every(v => !v.paused && !v.seeking && v.readyState >= 3)) {
                const follower = loaded[1], drift = master.currentTime - follower.currentTime;
                const now = performance.now();
                if (Math.abs(drift) > 0.25 && now - lastCorrection > 1500) {
                    follower.currentTime = master.currentTime;
                    follower.playbackRate = 1; lastCorrection = now;
                } else {
                    follower.playbackRate = Math.abs(drift) > 0.04 ? 1 + Math.max(-0.04, Math.min(0.04, drift * 0.3)) : 1;
                }
            }
            paint();
        }
        if (!configured()[0]?.requestVideoFrameCallback) scheduleTick();
    }
    root.addEventListener('pointerdown', e => e.stopPropagation());
    root.addEventListener('keydown', e => e.stopPropagation());
    root.addEventListener('dragstart', e => {e.preventDefault(); e.stopPropagation();});
    if (canSelect) {
        root.addEventListener('dragover', handleDragOver, true);
        root.addEventListener('dragleave', event => {
            if (!root.contains(event.relatedTarget)) clearDrop();
        });
        for (const type of ['dragover', 'drop', 'dragend']) document.addEventListener(type, clearDrop, true);
        window.addEventListener('blur', clearDrop);
        root.addEventListener('drop', handleDrop, true);
    }
    busy(false); layout(); paint();
    cacheStatus();
    if (prepareScrubCache) sources.forEach((clip, index) => {if (clip?.url && !clip.local) void prepareCache(index);});
    return {
        element: root,
        setLanguage,
        selectFiles,
        handleDrop,
        handleDragOver,
        setMessages(messages) {
            selectButtons.forEach(updatePicker);
            messages.forEach((message, i) => {
                if (failures[i]) return;
                const side = i ? 'B' : 'A';
                const render = () => message === 'upstream' ? t('upstream', side) : message ? errorText(new Error(message), i) : '';
                importFeedback(i, render, message && message !== 'upstream' ? 'error' : '');
                importStatuses[i].title = message && message !== 'upstream' ? message : '';
            });
            retry.hidden = !onRetry || !(failures.some(Boolean) || messages.some(m => m && m !== 'upstream'));
        },
        getLayoutSize() {
            const hasVideo = ready().length > 0;
            const minHeight = [sourceInfo.element, controls, transport, notices, status].reduce((height, el) => height + (el.hidden ? 0 : el.offsetHeight + 4), 12);
            return {hasVideo, minHeight: minHeight + (hasVideo ? 80 : 0)};
        },
        dispose() {
            removeWheel();
            for (const type of ['dragover', 'drop', 'dragend']) document.removeEventListener(type, clearDrop, {capture:true});
            window.removeEventListener('blur', clearDrop);
            disposed = true; playRequest++; active = false; cacheAbort.abort(); stopFrames(); stopScrubPreviews(); splitControl.dispose();
            for (const cancel of seekCancels) cancel();
            snapshots.forEach(canvas => {canvas.width = canvas.height = 0;});
            videos.forEach(v => {v.pause(); v.removeAttribute('src'); v.load();});
            cacheVideos.forEach(v => {if (v) {v.pause(); v.removeAttribute('src'); v.load();}});
            root.remove();
        },
    };
}
