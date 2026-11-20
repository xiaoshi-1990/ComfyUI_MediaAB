// Run with: node --experimental-vm-modules --test tests/test_canvas_interactions.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const window = new EventTarget();
const document = Object.assign(new EventTarget(), {fullscreenElement: null});
const canvas = {graph: {}, allow_dragcanvas: true, ds: {offset: [0, 0], scale: 2},
    setDirty() {}, processMouseWheel(event) {this.lastWheel = event;}};
const context = vm.createContext({window, document, canvas,
    ResizeObserver: class {observe() {} disconnect() {}}, MutationObserver: class {observe() {} disconnect() {}},
    requestAnimationFrame: callback => {callback(); return 1;}, cancelAnimationFrame() {}});
const player = new vm.SourceTextModule(await readFile(new URL('../web/player.js', import.meta.url), 'utf8'), {context});
const localeCode = await readFile(new URL('../web/video_text.js', import.meta.url), 'utf8');
const infoCode = await readFile(new URL('../web/source_info.js', import.meta.url), 'utf8');
const languageCode = await readFile(new URL('../web/panel_language.js', import.meta.url), 'utf8');
const appModule = new vm.SourceTextModule('export const app = {canvas};', {context});
await player.link(specifier => specifier.endsWith('/app.js') ? appModule : new vm.SourceTextModule(
    specifier.endsWith('/panel_language.js') ? languageCode : specifier.endsWith('/source_info.js') ? infoCode :
    specifier.endsWith('/video_text.js') ? localeCode : 'export function applyAppearance() {}', {context}));
await player.evaluate();

class Root extends EventTarget {
    captured = new Set();
    closest() {return null;}
    setPointerCapture(id) {this.captured.add(id);}
    hasPointerCapture(id) {return this.captured.has(id);}
    releasePointerCapture(id) {this.captured.delete(id);}
}
function send(target, type, data = {}) {
    const event = Object.assign(new Event(type, {cancelable: true}),
        {pointerId: 1, button: 1, buttons: 4, clientX: 100, clientY: 100}, data);
    target.dispatchEvent(event);
    return event;
}

test('middle drag pans at the current canvas zoom and stops on release', () => {
    for (const scale of [0.5, 2]) {
        canvas.ds.scale = scale; canvas.ds.offset = [0, 0];
        const root = new Root(), dispose = player.namespace.canvasWheel(root);
        assert.equal(send(root, 'pointerdown').defaultPrevented, true);
        send(window, 'pointermove', {clientX: 140, clientY: 120});
        assert.deepEqual(canvas.ds.offset, [40 / scale, 20 / scale]);
        send(window, 'pointerup');
        send(window, 'pointermove', {clientX: 200});
        assert.deepEqual(canvas.ds.offset, [40 / scale, 20 / scale]);
        assert.equal(root.captured.size, 0);
        dispose();
    }
});

test('dispose and window blur release an active drag', () => {
    for (const end of ['dispose', 'blur', 'pointercancel']) {
        canvas.ds.offset = [0, 0];
        const root = new Root(), dispose = player.namespace.canvasWheel(root);
        send(root, 'pointerdown');
        if (end === 'dispose') dispose();
        else send(window, end);
        send(window, 'pointermove', {clientX: 140});
        assert.deepEqual(canvas.ds.offset, [0, 0]);
        assert.equal(root.captured.size, 0);
        dispose();
    }
});

test('left click, input controls, locked canvas and fullscreen do not start a pan', () => {
    const root = new Root(), dispose = player.namespace.canvasWheel(root);
    assert.equal(send(root, 'pointerdown', {button: 0}).defaultPrevented, false);
    root.closest = () => ({});
    assert.equal(send(root, 'pointerdown').defaultPrevented, false);
    root.closest = () => null;
    canvas.allow_dragcanvas = false;
    assert.equal(send(root, 'pointerdown').defaultPrevented, false);
    canvas.allow_dragcanvas = true;
    document.fullscreenElement = {contains: () => true};
    assert.equal(send(root, 'pointerdown').defaultPrevented, false);
    document.fullscreenElement = null;
    dispose();
});

test('wheel still reaches the canvas, and is detached on dispose', () => {
    const root = new Root(), dispose = player.namespace.canvasWheel(root);
    const event = send(root, 'wheel');
    assert.equal(canvas.lastWheel, event);
    dispose(); send(root, 'wheel');
    assert.equal(canvas.lastWheel, event);
});

class Element extends EventTarget {
    children = []; style = {}; dataset = {}; value = ''; attributes = {}; listeners = [];
    className = ''; classList = {add() {}, remove() {}, toggle() {}};
    append(...children) {this.children.push(...children);}
    add(child) {this.append(child); if (!this.value) this.value = child.value;}
    setAttribute(name, value) {this.attributes[name] = value;}
    removeAttribute(name) {delete this.attributes[name];}
    addEventListener(type, listener, options) {
        this.listeners.push({type, options}); super.addEventListener(type, listener, options);
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.className?.split(' ').includes(selector.slice(1))) return child;
            const nested = child.querySelector?.(selector); if (nested) return nested;
        }
        return null;
    }
    getBoundingClientRect() {return {left:100, width:800};}
    contains(element) {return this.children.includes(element);}
    pause() {} load() {} remove() {}
}

test('video drops fill the first free input at any position then replace by position once both are filled', async () => {
    document.createElement = () => new Element();
    context.Option = function(text, value) {return {text, value};};
    context.AbortController = AbortController;
    for (const [initial, expected] of [[[false,false],[0,1,1]], [[false,true],[0,0,1]], [[true,false],[1,0,1]], [[true,true],[1,0,1]]]) {
        const occupied = [...initial], selected = [];
        const view = player.namespace.createABPlayer([], {
            isOccupied: i => occupied[i],
            onSelectFile: async i => {occupied[i] = true; selected.push(i);},
        });
        assert(view.element.listeners.some(l => l.type === 'drop' && l.options === true));
        for (const clientX of [800,100,800]) {
            const event = new Event('drop', {cancelable:true});
            Object.assign(event, {clientX, dataTransfer:{files:[{name:'clip.mp4',type:'video/mp4'}]}});
            view.element.dispatchEvent(event);
            await new Promise(resolve=>setImmediate(resolve));
            assert(event.defaultPrevented);
        }
        assert.deepEqual(selected, expected);
        view.dispose();
    }
});

test('generated asset drops keep their nested output path and resolve ID-only references', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    context.URL = URL;
    context.location = new URL('http://localhost:8188');
    const data = asset => ({getData: key => key === 'application/x-comfy-asset-info' ? JSON.stringify(asset) : ''});
    const asset = {filename:'clip.mp4', media_kind:'video', type:'output', media_url:`/api/assets/${id}/content`, preview_url:'/api/view?filename=poster.png'};
    const expected = {filename:'clip.mp4', subfolder:'video/nested', type:'output'};
    const parse = a => ({...player.namespace.droppedVideos(data(a))[0]});
    assert.deepEqual(parse({...asset, display_name:'video/nested/clip.mp4'}), expected);
    assert.deepEqual(parse({...asset, subfolder:'video/nested'}), expected);
    assert.deepEqual(parse({...asset, media_url:'/api/view?filename=clip.mp4&type=output&subfolder=video%2Fnested'}), expected);
    assert.equal(parse(asset).assetId, id);
    assert.deepEqual({...player.namespace.assetDetailFile({tags:['output'], loader_path:'video/nested/clip.mp4'})}, expected);
});

test('empty controls and single B use the available panel, regardless of saved mode', () => {
    document.createElement = () => new Element();
    context.Option = function(text, value) {return {text, value};};
    context.AbortController = AbortController;
    for (const mode of ['slide', 'side', 'toggle']) {
        for (const clip of [null, {url:'b.mp4'}]) {
            const view = player.namespace.createABPlayer([null,clip], {preferences:{mode}});
            const stage = view.element.querySelector('.media-ab-stage');
            const [a, b, divider] = stage.children;
            assert.equal(stage.hidden, !clip);
            assert.equal(view.element.querySelector('.media-ab-transport').hidden, !clip);
            assert.equal(a.hidden, true);
            assert.equal(b.hidden, !clip);
            assert.equal(b.style.clipPath, '');
            assert.equal(divider.style.display, 'none');
            view.dispose();
        }
    }
});

test('frame buttons and arrows use the master timing before playback, including B alone', async () => {
    Object.assign(context, {AbortController, setTimeout, clearTimeout, Option: function(text, value) {return {text, value};}});
    document.createElement = () => new Element();
    for (const [side, fps] of [[0,24],[0,30],[1,60],[0,'30000/1001'],[1,null]]) {
        const clips = [null,null];
        clips[side] = {url:'blob:local', local:true, fps};
        if (!side) clips[1] = {url:'blob:follower', local:true, fps:60};
        const view = player.namespace.createABPlayer(clips);
        const stage = view.element.querySelector('.media-ab-stage');
        const [play, prev, next,,timeline] = view.element.querySelector('.media-ab-transport').children;
        const videos = clips.map((clip, i) => {
            const video = stage.children[i].children[0];
            if (clip) Object.assign(video, {duration:1, currentTime:0, readyState:2});
            return video;
        });
        send(videos[side], 'loadedmetadata');
        assert.equal(next.disabled, !fps);
        assert.equal(prev.disabled, !fps);
        assert.equal(play.disabled, false);
        assert.equal(timeline.disabled, false);
        next.onclick();
        send(stage, 'keydown', {key:'ArrowRight'});
        if (fps) {
            const rate = typeof fps === 'string' ? 30000/1001 : fps;
            await new Promise(resolve => setImmediate(resolve));
            // Two rapid inputs coalesce at frame 2. The follower uses the same media time.
            videos.forEach((video, i) => {
                if (clips[i]) {
                    assert(Math.abs(video.currentTime - 2/rate) < .00002);
                    send(video, 'seeked');
                }
            });
            await new Promise(resolve => setImmediate(resolve));
            prev.onclick();
            await new Promise(resolve => setImmediate(resolve));
            assert(Math.abs(videos[side].currentTime - 1/rate) < .00002);
            videos.forEach(video => send(video, 'seeked'));
        } else {
            assert.equal(videos[side].currentTime, 0);
            assert.match(view.element.querySelector('.ve-playback-status').textContent, /stepping unavailable/i);
        }
        view.dispose();
    }
});

test('switching language updates controls and pending messages on the mounted player', () => {
    const saved = {};
    const view = player.namespace.createABPlayer([null, {url:'b.mp4'}], {
        onSelectFile() {}, onPreference(key, value) {saved[key] = value;},
    });
    const toolbar = view.element.querySelector('.media-ab-toolbar');
    const [pickA,,pickB] = toolbar.children;
    const language = view.element.querySelector('.video-ab-language');
    const mode = toolbar.children.find(el => el.attributes?.['aria-label'] === 'Comparison mode');
    view.setMessages(['upstream',null]);
    const status = view.element.querySelector('.ve-import-status');
    assert.equal(pickA.textContent, 'Select A'); assert.equal(pickB.textContent, 'Replace B');
    assert.match(status.textContent, /upstream/);
    language.onclick();
    assert.equal(saved.language, 'zh'); assert.equal(view.element.lang, 'zh-CN');
    assert.equal(pickA.textContent, '选择 A'); assert.equal(pickB.textContent, '替换 B');
    assert.equal(mode.children[1].textContent, '左右并排'); assert.match(status.textContent, /运行上游/);
    language.onclick(); assert.equal(view.element.lang, 'en'); assert.equal(mode.children[1].textContent, 'Side by side');
    view.dispose();
});

test('canvas forwards video drops to the same automatic importer and ignores other files', async () => {
    const sandbox = vm.createContext({extension:null});
    const script = new vm.SourceTextModule(await readFile(new URL('../web/video_ab.js', import.meta.url), 'utf8'), {context:sandbox});
    await script.link(specifier => {
        let code = 'export function prepareScrubCache() {}';
        if (specifier.endsWith('/panel_language.js')) code = 'export const panelLanguage = () => \'en\'; export function watchPanelLanguage() {}';
        else if (specifier.endsWith('/video_text.js')) code = localeCode;
        else if (specifier.endsWith('/local_video_timing.js')) code = 'export async function readLocalFrameRate() {return null;}';
        else if (specifier.endsWith('/app.js')) code = 'export const app = {registerExtension(e) {extension=e;}}';
        else if (specifier.endsWith('/api.js')) code = 'export const api = {}';
        else if (specifier.endsWith('/player.js')) code = 'export function createABPlayer() {} export function assetDetailFile() {} export const isVideoFilename = name => /\\.mp4$/i.test(name);';
        return new vm.SourceTextModule(code, {context:sandbox});
    });
    await script.evaluate();
    class Node {}
    await sandbox.extension.beforeRegisterNodeDef(Node,{name:'VideoEditCompare'});
    const node = new Node(), imported = [];
    node.pos = [0,0]; node.size = [320,180]; node.inputs = [];
    node.widgets = [{name:'video_a',value:''},{name:'video_b',value:''}];
    node._videoAB = {handleDrop(event) {imported.push(event.dataTransfer.files[0].name); return true;}};
    const drop = (name, canvasX) => ({canvasX,dataTransfer:{files:[{name}]},preventDefault(){},stopPropagation(){}});
    assert.equal(node.onDragDrop(drop('one.mp4',260)),true);
    node.widgets[0].value = 'input/one.mp4';
    assert.equal(node.onDragDrop(drop('two.mp4',25)),true);
    assert.deepEqual(imported,['one.mp4','two.mp4']);
    assert.equal(node.onDragDrop(drop('workflow.json')),false);
});
