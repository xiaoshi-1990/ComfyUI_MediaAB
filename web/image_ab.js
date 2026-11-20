import { panelLanguage, watchPanelLanguage } from './panel_language.js';
import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';
import { mouseDivider, canvasWheel, mediaDropIndex } from './player.js';
import { applyAppearance } from './appearance.js';
import { createSourceInfo } from './source_info.js';

const viewURL = clip => clip.url?.startsWith('/') && !clip.url.startsWith('//') ? clip.url :
    api.apiURL('/view?' + new URLSearchParams({filename: clip.filename, subfolder: clip.subfolder || '', type: clip.type || 'input'}));

const messages = {
    en: {
        title: 'Image A/B Compare', mode: 'Comparison mode', slide: 'Slide Compare', side: 'Side by side', toggle: 'A/B Toggle',
        selectButton: 'Select {side}', replaceButton: 'Replace {side}',
        drop: 'Drop to fill image {side}', dropReplace: 'Drop to replace image {side}', working: 'Importing…',
        select: 'Select image {side}', replace: 'Replace image {side}', image: 'Image {side}', show: 'Show {side}',
        fullscreen: 'Fullscreen', language: 'Switch to Chinese', importing: 'Importing {side}…',
        readError: 'Cannot load image {side}. Select it again or run the node.', fullscreenError: 'Fullscreen is unavailable.',
        fileType: 'Select an image file.', noGraph: 'Add this node to a workflow first.',
        busy: 'Wait for the current image import.',
        oneFile: 'Drop one image at a time.',
        connectionChanged: 'The connection changed during import. Select the image again.',
    },
    zh: {
        title: '图片A/B对比', mode: '对比模式', slide: '滑动对比', side: '左右并排', toggle: 'A/B 切换',
        selectButton: '选择 {side}', replaceButton: '替换 {side}',
        drop: '松开填入图片 {side}', dropReplace: '松开替换图片 {side}', working: '正在导入…',
        select: '选择 {side} 图片', replace: '替换 {side} 图片', image: '{side} 图片', show: '显示 {side}',
        fullscreen: '全屏', language: 'Switch to English', importing: '正在导入 {side}…',
        readError: '{side} 图片读取失败，请重新选择或运行节点。', fullscreenError: '当前浏览器不允许全屏。',
        fileType: '请选择图片文件。', noGraph: '请先将节点放到工作流中。',
        busy: '请等待当前图片导入完成。',
        oneFile: '请一次拖入一张图片。',
        connectionChanged: '导入期间连接已改变，请重新选择图片。',
    },
};
const titles = new Set(['ImageEditCompare', 'Image A/B Compare', '图片A/B对比', '图片 A/B 对比', '图片 A/B 对比 · 鼠标分割', '图片 A/B 对比 · 滑动对比']);

export function createImageABPlayer(clips, {onResize = () => {}, onSelectFile = null, language, view = 'slide',
    isOccupied = i => Boolean(clips?.[i]), onLanguageChange = () => {}, onViewChange = () => {}} = {}) {
    language = panelLanguage(language);
    const text = (key, side = '') => (messages[language][key] || key).replace('{side}', side);
    const root = document.createElement('div');
    root.className = 'media-ab image-ab-player';
    const removeWheel = canvasWheel(root);
    const controls = document.createElement('div');
    controls.className = 'media-ab-toolbar';
    const mode = document.createElement('select');
    for (const name of ['slide', 'side', 'toggle']) mode.add(new Option(text(name), name));
    mode.value = ['slide', 'side', 'toggle'].includes(view) ? view : 'slide';
    const toggle = document.createElement('button'); toggle.type = 'button';
    const fullscreen = document.createElement('button'); fullscreen.textContent = '⛶'; fullscreen.type = 'button';
    const locale = document.createElement('button'); locale.type = 'button'; locale.className = 'image-ab-language';
    const screen = document.createElement('div');
    screen.className = 'media-ab-stage';
    const status = document.createElement('div'); status.setAttribute('role', 'status');
    status.className = 'media-ab-info';
    const panes = [], images = [], pickers = [];
    const sourceInfo = createSourceInfo();
    let showB = false, disposed = false, pending = false, feedback = null, dragIndex = null;
    async function selectFile(index, file) {
        if (!file || pending || disposed) return;
        pending = true; feedback = {key: 'importing', side: index ? 'B' : 'A'}; layout();
        try {await onSelectFile(index, file); feedback = null;}
        catch (error) {feedback = {key: error.message, side: index ? 'B' : 'A'};}
        finally {pending = false; if (!disposed) layout();}
    }
    for (let i = 0; i < 2; i++) {
        const letter = i ? 'B' : 'A', clip = clips?.[i];
        if (onSelectFile) {
            const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.hidden = true;
            const pick = document.createElement('button'); pick.type = 'button'; pickers[i] = pick;
            pick.className = `image-ab-file-${letter.toLowerCase()}`;
            pick.dataset.side = letter;
            pick.onclick = () => input.click();
            input.onchange = () => {
                const file = input.files[0]; input.value = '';
                void selectFile(i, file);
            };
            controls.append(pick, input);
        }
        const pane = document.createElement('div');
        const image = document.createElement('img');
        image.draggable = false; image.decoding = 'async';
        image.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
        image.onload = () => {if (!disposed) layout();};
        image.onerror = () => {feedback = {key: 'readError', side: letter}; if (!disposed) layout();};
        if (clip?.url) image.src = clip.url;
        else image.style.visibility = 'hidden';
        pane.append(image); panes.push(pane); images.push(image); screen.append(pane);
    }
    const divider = document.createElement('div');
    divider.className = 'media-ab-divider'; screen.append(divider);
    const split = mouseDivider(screen, panes[1], divider, () => mode.value === 'slide' && images.every(image => image.naturalWidth));
    function layout() {
        if (disposed) return;
        const ref = images.find(image => image.naturalWidth);
        const both = images.every(image => image.naturalWidth);
        const side = both && mode.value === 'side', wipe = both && mode.value === 'slide';
        root.lang = language === 'zh' ? 'zh-CN' : 'en';
        screen.hidden = !ref; root.classList.toggle('image-ab-empty', !ref);
        mode.hidden = fullscreen.hidden = !ref; mode.disabled = !both;
        mode.setAttribute('aria-label', text('mode'));
        for (const option of mode.options) option.textContent = text(option.value);
        fullscreen.title = text('fullscreen'); fullscreen.setAttribute('aria-label', text('fullscreen'));
        locale.textContent = language === 'en' ? 'EN' : '中';
        locale.title = text('language'); locale.setAttribute('aria-label', text('language'));
        images.forEach((image, i) => {
            sourceInfo.update(i, image.naturalWidth, image.naturalHeight, clips?.[i]?.filename);
            const letter = i ? 'B' : 'A';
            image.alt = text('image', letter);
            if (!pickers[i]) return;
            const action = isOccupied(i) ? 'replace' : 'select';
            pickers[i].textContent = text(`${action}Button`, letter);
            pickers[i].title = text(action, letter);
            pickers[i].setAttribute('aria-label', pickers[i].title); pickers[i].disabled = pending;
        });
        panes[0].style.cssText = `position:absolute;inset:0;${side ? 'right:50%;' : ''}`;
        panes[1].style.cssText = `position:absolute;inset:0;${side ? 'left:50%;' : ''}`;
        panes[0].hidden = !images[0].naturalWidth || both && !side && !wipe && showB;
        panes[1].hidden = !images[1].naturalWidth || both && !side && !wipe && !showB;
        split.paint(); toggle.hidden = !both || mode.value !== 'toggle'; toggle.textContent = showB ? 'A' : 'B';
        toggle.title = text('show', toggle.textContent); toggle.setAttribute('aria-label', toggle.title);
        screen.style.aspectRatio = String((ref ? ref.naturalWidth / ref.naturalHeight : 16 / 9) * (side ? 2 : 1));
        status.textContent = feedback ? text(feedback.key, feedback.side) : ''; status.hidden = !feedback;
        if (dragIndex !== null) paintDrop(dragIndex);
        onResize();
    }
    mode.onchange = () => {onViewChange(mode.value); layout();}; toggle.onclick = () => {showB = !showB; layout();};
    locale.onclick = () => {language = language === 'en' ? 'zh' : 'en'; onLanguageChange(language); layout();};
    fullscreen.onclick = () => root.requestFullscreen?.().catch(() => {feedback = {key: 'fullscreenError'}; layout();});
    for (const kind of ['pointerdown', 'keydown']) root.addEventListener(kind, event => event.stopPropagation());
    root.addEventListener('dragstart', event => {event.preventDefault(); event.stopPropagation();});
    function paintDrop(index = null) {
        dragIndex = index;
        if (index === null) {
            delete root.dataset.dropHint;
            delete root.dataset.replaceSide;
            return;
        }
        const side = index ? 'B' : 'A';
        const replacing = isOccupied(index);
        if (replacing && !pending) root.dataset.replaceSide = side;
        else delete root.dataset.replaceSide;
        root.dataset.dropHint = pending ? text('working') : text(replacing ? 'dropReplace' : 'drop', side);
    }
    const clearDrop = () => paintDrop();
    const canDrop = data => Array.from(data?.types || []).some(type =>
        ['Files', 'application/x-comfy-asset-info', 'text/uri-list'].includes(type));
    function handleDragOver(event, canvasSide) {
        if (!onSelectFile || !canDrop(event.dataTransfer)) return false;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = pending ? 'none' : 'copy';
        paintDrop(mediaDropIndex(root, pickers, isOccupied, event, canvasSide));
        return true;
    }
    function handleDrop(event, canvasSide) {
        if (!onSelectFile || !canDrop(event.dataTransfer)) return false;
        event.preventDefault(); event.stopPropagation(); clearDrop();
        if (pending) {feedback = {key:'busy'}; layout(); return true;}
        const index = mediaDropIndex(root, pickers, isOccupied, event, canvasSide);
        const files = event.dataTransfer.files;
        let asset;
        try {asset = JSON.parse(event.dataTransfer.getData('application/x-comfy-asset-info') || 'null');}
        catch {asset = null;}
        if (!asset && files.length > 1) {feedback = {key: 'oneFile'}; layout(); return true;}
        if (!asset && files.length) {void selectFile(index, files[0]); return true;}
        const uri = event.dataTransfer.getData('text/uri-list').split(/[\r\n]+/).find(line => line && !line.startsWith('#'));
        const url = asset?.media_url || uri || asset?.preview_url || (asset?.filename ? viewURL(asset) : null);
        if (url) void selectFile(index, {...asset, url});
        else {feedback = {key: 'fileType'}; layout();}
        return true;
    }
    if (onSelectFile) {
        root.addEventListener('dragover', handleDragOver, true);
        root.addEventListener('drop', handleDrop, true);
        root.addEventListener('dragleave', event => {if (!root.contains(event.relatedTarget)) clearDrop();});
        for (const type of ['dragover', 'drop', 'dragend']) document.addEventListener(type, clearDrop, true);
        window.addEventListener('blur', clearDrop);
    }
    applyAppearance(root);
    controls.append(mode, toggle, fullscreen, locale);
    root.append(sourceInfo.element, controls, screen, status); layout();
    return {
        element: root,
        setLanguage(next) {if (next !== language) {language = next; layout();}},
        handleDragOver,
        handleDrop,
        getLayoutSize() {
            const hasImages = !screen.hidden;
            const controlsHeight = controls.offsetHeight + (status.hidden ? 0 : status.offsetHeight + 6) + (hasImages ? 6 : 0);
            return {
                hasImages,
                minHeight: controlsHeight + (hasImages ? 80 + sourceInfo.element.offsetHeight + 6 : 0),
            };
        },
        dispose() {
            disposed = true; removeWheel(); split.dispose();
            for (const type of ['dragover', 'drop', 'dragend']) document.removeEventListener(type, clearDrop, true);
            window.removeEventListener('blur', clearDrop);
            images.forEach(image => {image.onload = image.onerror = null; image.removeAttribute('src');}); root.remove();
        },
    };
}

app.registerExtension({
    name: 'VideoAB.ImageCompare',
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== 'ImageEditCompare') return;
        const value = (node, name) => node.widgets?.find(widget => widget.name === name)?.value;
        const localFile = (node, index) => {
            const clip = node.inputs?.[index]?.link == null ? node._imageABLocal?.[index] || node.properties.image_ab_files?.[index] : null;
            return clip || null;
        };
        const saveClips = (node, clips) => {node.properties.image_ab = clips.map(clip => clip?.url?.startsWith('blob:') ? null : clip);};
        function clearLocal(node) {
            node._imageABLocal?.forEach(clip => {if (clip) URL.revokeObjectURL(clip.url);});
            node._imageABLocal = null;
        }
        function inputState(node, index) {
            const path = [], visited = new Set();
            let id = node.inputs?.[index]?.link, source;
            while (id != null && !visited.has(id)) {
                visited.add(id);
                const link = node.graph?.links?.[id];
                path.push([id, link?.origin_id, link?.origin_slot]);
                source = link && node.graph.getNodeById(link.origin_id);
                if (source?.type !== 'Reroute') break;
                id = source.inputs?.[0]?.link;
            }
            const loader = source?.type === 'LoadImage';
            const file = loader ? value(source, 'image') : null;
            const local = localFile(node, index);
            const computed = source && !loader && source.type !== 'Reroute';
            return {key: JSON.stringify([path, source?.type, file, local]), file, local, computed};
        }
        function finishImport(node) {
            const pending = node._imageABImport;
            if (!pending) return;
            node._imageABImport = null;
            pending.image.removeAttribute('src');
            if (pending.objectURL) URL.revokeObjectURL(pending.objectURL);
        }
        function show(node, clips) {
            node._imageAB?.dispose();
            updateTitle(node);
            node._imageAB = createImageABPlayer(clips.map((clip, i) => clip ? {...clip,
                url: clip.url && node._imageABLocal?.[i]?.url === clip.url ? clip.url : viewURL(clip)} : null), {
                onResize: () => resize(node),
                language: node.properties.image_ab_language,
                isOccupied: i => node.inputs?.[i]?.link != null || Boolean(localFile(node, i) || clips[i]),
                view: node.properties.image_ab_mode,
                onLanguageChange(language) {node.properties.image_ab_language = language; updateTitle(node); node.graph?.change();},
                onViewChange(view) {node.properties.image_ab_mode = view; node.graph?.change();},
                async onSelectFile(index, file) {
                    if (file instanceof File && !file.type.startsWith('image/')) throw new Error('fileType');
                    const graph = node.graph, initial = inputState(node, index).key;
                    if (!graph) throw new Error('noGraph');
                    if (node._imageABImport) throw new Error('busy');
                    const pending = node._imageABImport = {image: new Image(), objectURL: null};
                    try {
                        let clip;
                        if (file instanceof File) {
                            pending.objectURL = URL.createObjectURL(file);
                            clip = {url: pending.objectURL, filename: file.name};
                        } else {
                            let url;
                            try {url = new URL(file.url, location.href);}
                            catch {throw new Error('fileType');}
                            if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol) || file.media_kind && file.media_kind !== 'image') throw new Error('fileType');
                            const filename = file.filename || url.searchParams.get('filename');
                            if (/\/assets\/[^/]+\/content$/.test(url.pathname)) {
                                clip = {url: url.pathname + url.search};
                                if (filename) clip.filename = filename;
                            } else if (filename) {
                                const type = file.type || url.searchParams.get('type') || 'input';
                                if (typeof filename !== 'string' || !['input', 'output', 'temp'].includes(type)) throw new Error('fileType');
                                let path = filename.replaceAll('\\', '/');
                                const folder = file.subfolder || url.searchParams.get('subfolder');
                                const display = file.display_name?.replaceAll('\\', '/');
                                if (!folder && !path.includes('/') && display?.endsWith('/' + path)) path = display;
                                const parts = path.split('/');
                                clip = {filename: parts.pop(), subfolder: [folder, ...parts].filter(Boolean).join('/'), type};
                            } else clip = {url: url.pathname + url.search};
                        }
                        pending.image.src = pending.objectURL || viewURL(clip);
                        try {await pending.image.decode();}
                        catch {throw new Error('readError');}
                        if (node._imageABImport !== pending || node.graph !== graph || node._imageABRemoved) return;
                        if (inputState(node, index).key !== initial) throw new Error('connectionChanged');
                        if (node.inputs?.[index]?.link != null) node.disconnectInput(index);
                        const files = node.properties.image_ab_files ??= [null, null];
                        const previous = node._imageABLocal?.[index];
                        files[index] = pending.objectURL ? null : clip;
                        if (pending.objectURL) (node._imageABLocal ??= [null, null])[index] = clip;
                        else if (node._imageABLocal) node._imageABLocal[index] = null;
                        pending.objectURL = null;
                        if (previous) URL.revokeObjectURL(previous.url);
                        finishImport(node);
                        refresh(node); graph.change();
                    } finally {
                        if (node._imageABImport === pending) finishImport(node);
                    }
                },
            });
            if (!node._imageABMount) {
                node._imageABMount = document.createElement('div'); node._imageABMount.className = 'image-ab-mount';
                node._imageABWidget = node.addDOMWidget('image_ab_preview', 'image_ab', node._imageABMount, {serialize: false, hideOnZoom: false,
                    getMinHeight: () => (node._imageAB?.getLayoutSize().minHeight || 28) + 2 * (node._imageABWidget?.margin ?? 10),
                    afterResize() {this.width = node.size[0]; resize(node);},
                });
            }
            node._imageABMount.replaceChildren(node._imageAB.element);
            node._imageABObserver ??= new ResizeObserver(() => resize(node));
            node._imageABObserver.disconnect(); node._imageABObserver.observe(node._imageAB.element);
            resize(node);
        }
        function resize(node) {
            cancelAnimationFrame(node._imageABResizeFrame);
            node._imageABResizeFrame = requestAnimationFrame(() => {
                if (node._imageABRemoved || document.fullscreenElement?.contains(node._imageAB?.element)) return;
                let width = Math.max(280, node.size[0]);
                const layout = node._imageAB.getLayoutSize();
                let height = Math.max(node.size[1], Math.ceil(node.computeSize()[1]));
                if (node._imageABFitOnMount && node._imageAB.element.clientWidth) {
                    node._imageABFitOnMount = false;
                    if (!layout.hasImages) width = 320;
                    height = Math.ceil(node.computeSize()[1]);
                }
                if (layout.hasImages && node._imageAB.element.clientWidth && !node._imageABHadPreview) {
                    node._imageABHadPreview = true;
                    width = Math.max(width, 760);
                    height = Math.max(height, 520);
                }
                if (node.size[0] !== width || node.size[1] !== height) node.setSize([width, height]);
                node._imageABWidget.width = width;
                node.setDirtyCanvas(true, true);
            });
        }
        function updateTitle(node) {
            if (titles.has(node.title)) node.title = messages[panelLanguage(node.properties.image_ab_language)].title;
        }
        function refresh(node, executed = null) {
            if (!node.graph || node._imageABRemoved) return;
            const states = [0, 1].map(i => inputState(node, i));
            const previous = node._imageABSignature;
            if (!executed && states.every(({key}, i) => key === previous?.[i])) return;
            const clips = states.map(({file, key, local, computed}, i) => {
                if (local || executed) return local || executed[i] || null;
                // A computed preview belongs to the wiring that produced it. On restore,
                // the first read adopts the saved preview for a connected computed input.
                if (key === previous?.[i] || (!previous && computed)) return node.properties.image_ab?.[i] || null;
                if (!file) return null;
                const match = file.match(/^(.*?)(?: \[(input|output|temp)\])?$/);
                const parts = match[1].replaceAll('\\', '/').split('/');
                return {filename: parts.pop(), subfolder: parts.join('/'), type: match[2] || 'input'};
            });
            node._imageABSignature = states.map(state => state.key);
            saveClips(node, clips); show(node, clips);
        }
        const dragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function(event) {
            const index = event.canvasX < this.pos[0] + this.size[0] / 2 ? 0 : 1;
            return this._imageAB?.handleDragOver(event, index) || dragOver?.apply(this, arguments);
        };
        const dragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = function(event) {
            const index = event.canvasX < this.pos[0] + this.size[0] / 2 ? 0 : 1;
            return this._imageAB?.handleDrop(event, index) || dragDrop?.apply(this, arguments);
        };
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = created?.apply(this, arguments); this._imageABRemoved = false;
            this._imageABStopLanguage = watchPanelLanguage(() => {
                this._imageAB?.setLanguage(panelLanguage(this.properties.image_ab_language));
                updateTitle(this);
            });
            this._imageABFitOnMount = true;
            show(this, this.properties?.image_ab || [null, null]);
            this.setSize([320, this.computeSize()[1]]);
            this._imageABTimer = setInterval(() => refresh(this), 600); return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function(message) {
            executed?.apply(this, arguments);
            if (!message.image_ab || this._imageABRemoved) return;
            refresh(this, message.image_ab);
        };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function() {
            finishImport(this);
            configure?.apply(this, arguments); clearLocal(this); this._imageABSignature = null;
            this._imageABHadPreview = (this.properties?.image_ab || []).some(Boolean);
            this._imageABFitOnMount = !this._imageABHadPreview;
            show(this, this.properties?.image_ab || [null, null]);
            if (!this._imageABHadPreview) this.setSize([320, this.computeSize()[1]]);
            // Resolve links after the graph finishes configuring the other nodes.
            queueMicrotask(() => refresh(this));
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function() {
            this._imageABRemoved = true; finishImport(this); clearInterval(this._imageABTimer); cancelAnimationFrame(this._imageABResizeFrame);
            this._imageABStopLanguage?.(); this._imageABObserver?.disconnect(); this._imageAB?.dispose(); clearLocal(this); removed?.apply(this, arguments);
        };
    },
});
