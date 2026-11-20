import { panelLanguage, watchPanelLanguage } from './panel_language.js';
import { videoText } from './video_text.js';
import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';
import { createABPlayer, assetDetailFile, isVideoFilename } from './player.js';
import { prepareScrubCache } from './scrub_cache.js';
import { readLocalFrameRate } from './local_video_timing.js';

const VIDEO_INPUT = 'VIDEO,VHS_FILENAMES,STRING';

function viewURL(clip) {
    const params = new URLSearchParams({filename:clip.filename, subfolder:clip.subfolder || '', type:clip.type || 'input'});
    if (clip.version) params.set('v', clip.version);
    return api.apiURL('/view?' + params);
}

// Decode the first frame before replacing an existing selection or disconnecting an input.
async function checkVideo(url, signal, errorKey) {
    const probe = document.createElement('video');
    probe.preload = 'auto';
    probe.muted = true;
    let timer, cancel;
    try {
        await new Promise((resolve, reject) => {
            cancel = () => reject(new DOMException('Aborted', 'AbortError'));
            signal.throwIfAborted();
            signal.addEventListener('abort', cancel, {once:true});
            const fail = () => reject(new Error(errorKey));
            probe.onloadeddata = () => probe.videoWidth ? resolve() : fail();
            probe.onerror = fail;
            timer = setTimeout(fail, 15000);
            probe.src = url;
        });
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        probe.onloadeddata = probe.onerror = null;
        probe.removeAttribute('src');
        probe.load();
    }
}

function clearLocalVideo(node, index) {
    const clip = node._videoABLocal?.[index];
    if (!clip) return;
    URL.revokeObjectURL(clip.url);
    node._videoABLocal[index] = null;
}

app.registerExtension({
    name: 'VideoAB.Compare',
    beforeConfigureGraph(workflow) {
        for (const graph of [workflow, ...(workflow.definitions?.subgraphs || [])]) {
            const compareIds = new Set((graph.nodes || []).filter(n => n.type === 'VideoEditCompare').map(n => n.id));
            if (!compareIds.size) continue;
            const removed = new Set();
            for (const node of graph.nodes) {
                if (!compareIds.has(node.id)) continue;
                node.inputs = (node.inputs || []).filter(input => {
                    if (!['label_a', 'label_b'].includes(input.name)) return true;
                    if (input.link != null) removed.add(input.link);
                    return false;
                });
                if (Array.isArray(node.widgets_values)) node.widgets_values = node.widgets_values.slice(0, 2);
                delete node.widgets_values_named?.label_a;
                delete node.widgets_values_named?.label_b;
                delete node.properties?.video_ab_view?.fields;
            }
            if (graph.links) graph.links = graph.links.filter(link => {
                const origin = Array.isArray(link) ? link[1] : link.origin_id;
                if (!compareIds.has(origin)) return !removed.has(Array.isArray(link) ? link[0] : link.id);
                removed.add(Array.isArray(link) ? link[0] : link.id);
                return false;
            });
            for (const node of graph.nodes) {
                if (compareIds.has(node.id)) node.outputs = [];
                for (const input of node.inputs || []) if (removed.has(input.link)) input.link = null;
                for (const output of node.outputs || []) {
                    if (output.links) output.links = output.links.filter(id => !removed.has(id));
                }
            }
        }
    },
    getCustomWidgets() {
        return {[VIDEO_INPUT]: (node, name, data) => {
            // Keep the serialized value and prompt input for picked files and legacy workflows.
            const widget = node.addWidget('text', name, data[1]?.default || '', () => {}, {});
            widget.hidden = true;
            return {widget};
        }};
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== 'VideoEditCompare') return;
        function updateInputTypes(node) {
            const language = panelLanguage(node.properties?.video_ab_view?.language);
            const defaultTitles = ['VideoEditCompare', '视频 A/B 对比 · 滑动对比', '视频 A/B 对比', '视频A/B对比', 'Video A/B Compare'];
            if (defaultTitles.includes(node.title)) node.title = videoText(language, 'title');
            for (const name of ['video_a', 'video_b']) {
                const type = nodeData.input.required[name][0];
                const input = node.inputs?.find(input => input.name === name) || node.addInput(name, type);
                input.type = type;
                input.label = videoText(language, 'video', name === 'video_a' ? 'A' : 'B');
                input.localized_name = input.label;
                // Position the socket as a regular input, independently of its hidden backing value.
                delete input.widget;
                const widget = node.widgets?.find(widget => widget.name === name);
                if (widget) widget.hidden = true;
            }
        }
        function resize(node) {
            cancelAnimationFrame(node._videoABFrame);
            node._videoABFrame = requestAnimationFrame(() => {
                const player = node._videoAB;
                if (!player || node._videoABRemoved || document.fullscreenElement?.contains(player.element)) return;
                let width = Math.max(300, node.size[0]);
                let height = Math.max(node.size[1], Math.ceil(node.computeSize()[1]));
                if (node._videoABFit && player.element.clientWidth) {
                    node._videoABFit = false;
                    height = Math.ceil(node.computeSize()[1]);
                }
                if (!node._videoABExpanded && player.element.clientWidth && player.getLayoutSize().hasVideo) {
                    node._videoABExpanded = true;
                    width = Math.max(760, width); height = Math.max(520, height);
                }
                if (width !== node.size[0] || height !== node.size[1]) node.setSize([width, height]);
                node._videoABWidget.width = width;
                node.setDirtyCanvas(true, true);
            });
        }
        function show(node, clips, errors = []) {
            const media = [0, 1].map(i => {
                if (node._videoABLocal?.[i]) return node._videoABLocal[i];
                const clip = clips?.[i];
                if (!clip) return null;
                return {url:viewURL(clip), filename:clip.filename, subfolder:clip.subfolder, type:clip.type,
                    fps:clip.fps};
            });
            const key = JSON.stringify(media);
            if (key !== node._videoABMedia) {
                node._videoABMedia = key;
                node._videoAB?.dispose();
                node._videoAB = createABPlayer(media, {
                    onResize: () => resize(node), prepareScrubCache,
                    onSelectFile: (index,file) => selectFile(node,index,file),
                    isOccupied: index => !!node._videoABLocal?.[index] || pathInput(node, index)?.link != null || Boolean(value(node, pathName(index))?.trim()),
                    preferences: node.properties.video_ab_view,
                    onPreference(name, setting) {
                        (node.properties.video_ab_view ??= {})[name] = setting;
                        if (name === 'language') updateInputTypes(node);
                        node.graph?.change();
                    },
                    onRetry() {node._videoABKeys = []; node._videoABMedia = null; void refresh(node);},
                });
                if (!node._videoABMount) {
                    const mount = node._videoABMount = document.createElement('div'); mount.className = 'video-ab-mount';
                    node._videoABWidget = node.addDOMWidget('video_ab_preview', 'video_ab', mount, {
                        serialize:false, hideOnZoom:false,
                        getMinHeight: () => (node._videoAB?.getLayoutSize().minHeight || 36) + 2 * (node._videoABWidget?.margin ?? 10),
                        afterResize() {this.width = node.size[0]; resize(node);},
                    });
                    node._videoABObserver = new ResizeObserver(() => resize(node));
                }
                node._videoABMount.replaceChildren(node._videoAB.element);
                node._videoABObserver.disconnect(); node._videoABObserver.observe(node._videoAB.element);
            }
            node._videoAB.setMessages(errors);
            resize(node);
        }
        const value = (node, name) => node.widgets?.find(w => w.name === name)?.value;
        const pathName = index => index ? 'video_b' : 'video_a';
        const pathInput = (node, index) => node.inputs?.find(input => input.name === pathName(index));
        function upstream(node, index) {
            let link = node.graph?.links?.[pathInput(node, index)?.link];
            const visited = new Set();
            while (link) {
                const source = node.graph.getNodeById(link.origin_id);
                if (!source || visited.has(source.id)) return null;
                visited.add(source.id);
                if (source.type !== 'Reroute') return source;
                link = node.graph.links[source.inputs?.[0]?.link];
            }
            return null;
        }
        function source(node, index) {
            if (pathInput(node, index)?.link != null) {
                const origin = upstream(node, index);
                if (['PrimitiveString', 'PrimitiveStringMultiline'].includes(origin?.type)) return {loader: 'VideoPath', file: value(origin, 'value') || ''};
                if (origin?.type === 'LoadVideo') return {loader: 'LoadVideo', file: value(origin, 'file') || ''};
                return null;
            }
            return {loader: 'VideoPath', file: value(node, pathName(index)) || ''};
        }
        function inputState(node, i) {
            const input = source(node, i);
            const link = pathInput(node,i)?.link;
            const origin = link != null ? upstream(node,i)?.id : null;
            return {input, key: JSON.stringify([input, link, origin])};
        }
        async function readPreviews(sources, signal) {
            const response = await api.fetchApi('/video_ab/compare_preview', {
                method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sources}), signal,
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '读取预览失败');
            return data;
        }
        async function selectFile(node, index, file) {
            const graph = node.graph, initial = inputState(node,index).key;
            if (!graph) throw new Error('noGraph');
            const controller = new AbortController(); node._videoABUpload?.abort(); node._videoABUpload = controller;
            let local = null;
            try {
                let path = '', persisted = null;
                if (file instanceof File) {
                    local = {url:URL.createObjectURL(file), filename:file.name, local:true};
                    await checkVideo(local.url, controller.signal, 'localDecode');
                    local.fps = await readLocalFrameRate(file);
                } else {
                    let clip = file;
                    if (file.assetId) {
                        const response = await api.fetchApi(`/assets/${file.assetId}`, {signal:controller.signal});
                        if (!response.ok) throw new Error('assetError');
                        clip = assetDetailFile(await response.json());
                    }
                    path = [clip.type, clip.subfolder, clip.filename].filter(part => part && part !== '.').join('/');
                    const inputs = [null,null]; inputs[index] = {loader:'VideoPath', file:path};
                    const data = await readPreviews(inputs, controller.signal);
                    persisted = data.video_ab[index];
                    if (!persisted) throw new Error(data.errors[index] || 'assetError');
                    await checkVideo(viewURL(persisted), controller.signal, 'assetError');
                }
                if (controller.signal.aborted || node.graph !== graph || node._videoABRemoved) return;
                if (inputState(node,index).key !== initial) throw new Error('changed');
                const input = pathInput(node,index);
                if (input?.link != null) node.disconnectInput(node.inputs.indexOf(input));
                const widget = node.widgets.find(w => w.name === pathName(index));
                widget.value = path; widget.callback?.(path);
                clearLocalVideo(node, index);
                (node._videoABLocal ??= [null,null])[index] = local;
                local = null;
                (node.properties.video_ab ??= [null,null])[index] = persisted;
                node._videoABKeys[index] = inputState(node,index).key;
                node._videoABErrors[index] = null;
                show(node,node.properties.video_ab,node._videoABErrors); graph.change();
            } finally {
                if (local) URL.revokeObjectURL(local.url);
                if (node._videoABUpload === controller) {node._videoABUpload = null; void refresh(node);}
            }
        }
        async function refresh(node) {
            if (!node.graph || node._videoABRemoved || node._videoABUpload) return;
            for (const i of [0, 1]) {
                if (pathInput(node, i)?.link != null || value(node, pathName(i))) clearLocalVideo(node, i);
            }
            const states = [0,1].map(i => inputState(node,i));
            const signature = JSON.stringify(states.map(s => s.key));
            if (node._videoABPending === signature) return;
            node._videoABAbort?.abort(); node._videoABPending = null;
            const changed = states.map((state,i) => state.key !== node._videoABKeys[i]);
            if (!changed.some(Boolean)) return;
            const controller = new AbortController(); node._videoABAbort = controller; node._videoABPending = signature;
            const sources = states.map(({input},i) => changed[i] && input?.file?.trim() ? input : null);
            let clips = [null,null], errors = [null,null];
            try {
                if (sources.some(Boolean)) ({video_ab:clips, errors} = await readPreviews(sources, controller.signal));
            } catch (error) {errors = sources.map(source => source ? error.message : null);}
            if (controller.signal.aborted) return;
            node._videoABPending = null; node._videoABAbort = null;
            if (!node.graph || node._videoABRemoved || node._videoABUpload) return;
            const result = node.properties.video_ab ??= [null,null];
            states.forEach(({key,input},i) => {
                if (!changed[i] || inputState(node,i).key !== key) return;
                const firstRead = node._videoABKeys[i] === undefined;
                // A saved computed result is valid on restore. Rewiring that side invalidates it.
                if (input || !firstRead) result[i] = clips[i];
                node._videoABErrors[i] = errors?.[i] ? `${i ? 'B' : 'A'} · ${errors[i]}` : !input && !result[i] ? 'upstream' : null;
                node._videoABKeys[i] = key;
            });
            show(node,result,node._videoABErrors);
        }
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = created?.apply(this, arguments);
            updateInputTypes(this);
            this._videoABRemoved = false; this._videoABFit = true; this._videoABKeys = []; this._videoABErrors = [null,null];
            show(this,[null,null]); this.setSize([340,this.computeSize()[1]]);
            this._videoABStopLanguage = watchPanelLanguage(() => {
                this._videoAB?.setLanguage(panelLanguage(this.properties.video_ab_view?.language));
                updateInputTypes(this);
            });
            this._videoABTimer = setInterval(() => refresh(this), 450);
            return result;
        };
        const dragOver = nodeType.prototype.onDragOver;
        const canvasSide = (node, event) => event.canvasX < node.pos[0] + node.size[0] / 2 ? 0 : 1;
        const assetDrop = event => [...(event.dataTransfer?.types || [])].some(t => ['application/x-comfy-asset-info','text/uri-list'].includes(t));
        nodeType.prototype.onDragOver = function(event) {
            if (assetDrop(event) || [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file' && (!item.type || item.type.startsWith('video/')))) {
                return this._videoAB?.handleDragOver(event, canvasSide(this, event)) || false;
            }
            return dragOver?.apply(this, arguments) || false;
        };
        const dragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = function(event) {
            if (!assetDrop(event) && ![...(event.dataTransfer?.files || [])].some(file => isVideoFilename(file.name))) return dragDrop?.apply(this, arguments) || false;
            return this._videoAB?.handleDrop(event, canvasSide(this, event)) || false;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function(message) {
            executed?.apply(this, arguments);
            if (!message.video_ab || this._videoABRemoved) return;
            this._videoABAbort?.abort(); this._videoABPending = null;
            const result = this.properties.video_ab ??= [null,null];
            message.video_ab.forEach((clip,i) => {
                const state = inputState(this,i);
                // An execution may finish after the user has replaced a path. Re-read the
                // current path when the result differs; computed inputs use the execution output.
                if (state.input) {
                    const prior = result[i];
                    if (state.key !== this._videoABKeys[i] || prior?.filename !== clip?.filename || prior?.version !== clip?.version) {
                        this._videoABKeys[i] = undefined;
                    }
                    return;
                }
                result[i] = clip; this._videoABKeys[i] = state.key; this._videoABErrors[i] = null;
            });
            show(this,result,this._videoABErrors); void refresh(this);
        };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function() {
            for (const i of [0, 1]) clearLocalVideo(this, i);
            configure?.apply(this, arguments); updateInputTypes(this);
            while (this.outputs?.length) this.removeOutput(this.outputs.length - 1);
            this._videoABUpload?.abort(); this._videoABAbort?.abort(); this._videoABPending = null;
            this._videoABKeys = []; this._videoABErrors = [null,null]; this._videoABMedia = null;
            this._videoABFit = false;
            this._videoABExpanded = !!this.properties.video_ab?.some(Boolean);
            show(this,this.properties.video_ab);
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function() {
            this._videoABRemoved = true;
            this._videoABStopLanguage?.();
            clearInterval(this._videoABTimer); this._videoABAbort?.abort();
            this._videoABUpload?.abort(); this._videoABObserver?.disconnect(); cancelAnimationFrame(this._videoABFrame);
            this._videoAB?.dispose();
            for (const i of [0, 1]) clearLocalVideo(this, i);
            removed?.apply(this, arguments);
        };
    },
});
