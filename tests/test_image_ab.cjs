// Run with Playwright available: node tests/test_image_ab.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');

const web = path.resolve(__dirname, '../web');
const output = process.env.MEDIA_AB_TEST_OUTPUT || path.join(os.tmpdir(), 'media-ab-image-test');
const html = `<!doctype html><meta charset="utf-8"><title>Image A/B regression test</title>
<style>
body{margin:32px;background:#18191b;color:#ddd;font:12px system-ui}main{display:flex;align-items:flex-start;gap:24px}
.node{background:#353535;border-radius:6px;overflow:hidden;flex-shrink:0}.title{padding:8px 10px;background:#292929}
.ports{display:flex;justify-content:space-between;padding:6px 10px}.mount{padding:0 10px;box-sizing:border-box}
</style><main></main><script type="module">
import {app} from '/scripts/app.js';
import {createImageABPlayer} from '/web/image_ab.js';
window.createPlayer = createImageABPlayer;
window.createdURLs = []; window.revokedURLs = [];
const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = file => {const url=createURL(file);createdURLs.push(url);return url;};
URL.revokeObjectURL = url => {revokedURLs.push(url);revokeURL(url);};
class TestNode {
    constructor() {
        this.title = 'ImageEditCompare'; this.properties = {}; this.pos = [0,0]; this.size = [140, 80]; this.widgets = [];
        this.inputs = [{name:'image_a',link:null},{name:'image_b',link:null}];
        this.sources = {};
        this.graph = {links:{}, getNodeById:id=>this.sources[id], change:()=>this.heading.textContent=this.title};
        this.shell = document.createElement('section'); this.shell.className = 'node';
        this.heading = document.createElement('div'); this.heading.className = 'title';
        const ports = document.createElement('div'); ports.className = 'ports'; ports.innerHTML = '<span>○ A</span><span>B ○</span>';
        this.mount = document.createElement('div'); this.mount.className = 'mount';
        this.shell.append(this.heading, ports, this.mount); document.querySelector('main').append(this.shell);
        this.onNodeCreated();
    }
    disconnectInput(index) {delete this.graph.links[this.inputs[index].link]; this.inputs[index].link = null;}
    addDOMWidget(name, type, element, options) {const widget={name,options,margin:10};this.widgets.push(widget);this.mount.append(element);return widget;}
    computeSize() {return [140, 60 + this.widgets.reduce((sum,widget)=>sum+widget.options.getMinHeight(),0)];}
    setSize(size) {this.size = [...size]; this.shell.style.width = size[0]+'px'; this.shell.style.minHeight = size[1]+'px'; this.mount.style.height = Math.max(0,size[1]-60)+'px'; this.heading.textContent = this.title;for(const widget of this.widgets)widget.options.afterResize?.call(widget);}
    setDirtyCanvas() {this.heading.textContent = this.title;this.mount.style.width=(this.widgets[0]?.width??this.size[0])+'px';}
}
await app.extension.beforeRegisterNodeDef(TestNode, {name:'ImageEditCompare'});
window.emptyNode = new TestNode(); emptyNode.shell.id = 'empty';
window.imageNode = new TestNode(); imageNode.shell.id = 'images';
window.clips = [{filename:'a.svg'},{filename:'b.svg'}];
imageNode.onExecuted({image_ab: clips});
window.ready = true;
</script>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/javascript;charset=utf-8');
    if (url.pathname === '/') {res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(html);}
    if (url.pathname === '/scripts/app.js') return res.end(`export const app=window.testApp={registerExtension(extension){this.extension=extension;},
        canvas:{graph:{},allow_dragcanvas:true,ds:{offset:[0,0],scale:2},setDirty(){},processMouseWheel(){this.wheels=(this.wheels||0)+1;}}};`);
    if (url.pathname === '/scripts/api.js') return res.end(`window.uploadCount=0;export const api={apiURL:url=>url,async fetchApi(){
        window.uploadCount=(window.uploadCount||0)+1;
        throw new Error('Unexpected image upload');
    }};`);
    if (url.pathname === '/assets/broken/content') {res.setHeader('Content-Type','image/png'); return res.end('invalid PNG');}
    if (url.pathname === '/view' || url.pathname === '/assets/generated/content') {
        const name = url.searchParams.get('filename');
        if (name === 'missing.svg') {res.statusCode = 404; return res.end();}
        const color = name === 'b.svg' ? '#758b88' : '#6f7b95';
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${name === 'portrait.svg' ? 960 : 360}"><rect width="100%" height="100%" fill="${color}"/><path d="M0 180H640M320 0V960" stroke="white" opacity=".25"/></svg>`);
    }
    if (url.pathname.startsWith('/web/')) return res.end(fs.readFileSync(path.join(web, path.basename(url.pathname))));
    res.statusCode = 404; res.end();
});

const svgFile = name => ({name, mimeType:'image/svg+xml', buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="11" height="9"/>')});

async function graphChanges(page) {
    await page.evaluate(()=>{
        const n = emptyNode;
        n.sources[1] = {id:1,type:'LoadImage',widgets:[{name:'image',value:'folder/a.svg [output]'}]};
        n.sources[2] = {id:2,type:'Computed'};
        n.sources[3] = {id:3,type:'Reroute',inputs:[{link:20}]};
        n.graph.links[10] = {origin_id:3};
        n.graph.links[20] = {origin_id:1};
        n.inputs[0].link = 10;
        n.properties.image_ab_files = [null, clips[1]];
        n.onConfigure();
    });
    await page.waitForFunction(()=>emptyNode.properties.image_ab?.[0]?.subfolder==='folder');
    await page.evaluate(()=>emptyNode.sources[1].widgets[0].value='');
    await page.waitForFunction(()=>!emptyNode.properties.image_ab[0] && !emptyNode._imageAB.element.querySelector('img').hasAttribute('src'));
    await page.locator('#empty').getByRole('button',{name:'Replace image A'}).waitFor();
    await page.evaluate(()=>{
        emptyNode.graph.links[20] = {origin_id:2};
        emptyNode.onExecuted({image_ab:clips});
        emptyNode.properties = JSON.parse(JSON.stringify(emptyNode.properties));
        emptyNode.onConfigure();
    });
    await page.waitForFunction(()=>emptyNode._imageABSignature && emptyNode._imageAB.element.querySelector('img').naturalWidth);
    assert.equal(await page.locator('#empty img').first().getAttribute('src'), '/view?filename=a.svg&subfolder=&type=input');
    await page.evaluate(()=>{
        emptyNode.sources[4] = {id:4,type:'Computed'};
        emptyNode.graph.links[20] = {origin_id:4};
    });
    await page.waitForFunction(()=>emptyNode.properties.image_ab[0]===null);
    await page.evaluate(()=>{emptyNode.onExecuted({image_ab:clips}); emptyNode.disconnectInput(0);});
    await page.locator('#empty').getByRole('button',{name:'Select image A'}).waitFor();
    assert.equal(await page.locator('#empty img').first().getAttribute('src'), null);
    assert.deepEqual(await page.evaluate(()=>emptyNode.properties.image_ab), [null,{filename:'b.svg'}]);
    const hint = await page.locator('#empty .media-ab-stage').evaluate(stage=>{
        const dataTransfer = new DataTransfer(); dataTransfer.setData('text/uri-list','/assets/generated/content');
        const rect = stage.getBoundingClientRect();
        stage.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientX:rect.right-1,clientY:rect.top+1}));
        return emptyNode._imageAB.element.dataset.dropHint;
    });
    assert.equal(hint,'Drop to fill image A','A disconnected side is available for the next drop');
}

async function rejectedAssets(page) {
    const picker = page.locator('#empty input[type=file]').nth(1);
    await picker.setInputFiles(svgFile('working.svg'));
    await page.waitForFunction(()=>emptyNode._imageABLocal?.[1]);
    await page.evaluate(()=>{
        emptyNode.sources[1] = {id:1,type:'LoadImage',widgets:[{name:'image',value:'a.svg'}]};
        emptyNode.graph.links[7] = {origin_id:1}; emptyNode.inputs[0].link = 7;
    });
    await page.waitForFunction(()=>emptyNode.properties.image_ab[0]?.filename==='a.svg');
    const snapshot = () => page.evaluate(()=>({
        link:emptyNode.inputs[0].link, properties:emptyNode.properties, urls:revokedURLs,
        images:[...emptyNode._imageAB.element.querySelectorAll('img')].map(image=>image.src),
    }));
    const drop = (side,url,changeSource=false) => page.locator('#empty button[data-side]').nth(side).evaluate((target,{url,changeSource})=>{
        const dataTransfer = new DataTransfer(); dataTransfer.setData('text/uri-list',url);
        target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
        if (changeSource) emptyNode.sources[1].widgets[0].value = 'portrait.svg';
    },{url,changeSource});
    for (const [side, url] of [[0,'/view?filename=missing.svg'],[1,'/assets/broken/content']]) {
        const before = await snapshot();
        await drop(side,url);
        await page.locator('#empty [role=status]').filter({hasText:'Cannot load image '+(side?'B':'A')}).waitFor();
        assert.deepEqual(await snapshot(), before, 'Failed replacement must preserve the link, saved references and both previews');
    }
    await drop(0,'/assets/generated/content',true);
    await page.waitForFunction(()=>!emptyNode._imageABImport && emptyNode._imageAB.element.querySelector('img').naturalHeight===960);
    assert.equal(await page.evaluate(()=>emptyNode.inputs[0].link),7,'An upstream change during decode supersedes the drop');
    await drop(0,'/assets/generated/content');
    await page.waitForFunction(()=>emptyNode.properties.image_ab_files[0]?.url==='/assets/generated/content' &&
        emptyNode._imageAB.element.querySelector('img').naturalWidth);
    assert.equal(await page.evaluate(()=>emptyNode.inputs[0].link),null,'A decodable replacement can disconnect the input');
}

async function pendingDecode(page, remove) {
    // Let Chromium decode real bytes, then control when the import receives the result.
    await page.evaluate(()=>{
        const decode = HTMLImageElement.prototype.decode;
        window.releaseDecodes = [];
        HTMLImageElement.prototype.decode = async function() {
            await decode.call(this);
            await new Promise(resolve=>releaseDecodes.push(resolve));
        };
    });
    const picker = page.locator('#empty input[type=file]').first();
    await picker.setInputFiles(svgFile('old.svg'));
    await page.waitForFunction(()=>releaseDecodes.length===1);
    const oldURL = await page.evaluate(()=>createdURLs.at(-1));
    await page.evaluate(remove=>{
        if (remove) emptyNode.onRemoved();
        else {
            emptyNode.properties = {image_ab_files:[clips[0],null],image_ab:[clips[0],null]};
            emptyNode.onConfigure();
        }
    },remove);
    assert.equal(await page.evaluate(url=>revokedURLs.includes(url),oldURL),true,'Lifecycle cleanup releases the pending URL before decode settles');
    if (!remove) {
        await picker.setInputFiles(svgFile('new.svg'));
        await page.waitForFunction(()=>releaseDecodes.length===2);
    }
    await page.evaluate(async ()=>{
        releaseDecodes[0]();
        await new Promise(resolve=>setTimeout(resolve,0));
    });
    assert.equal(await page.evaluate(url=>revokedURLs.filter(revoked=>revoked===url).length,oldURL),1);
    assert.equal(await page.evaluate(()=>emptyNode._imageABLocal?.[0] ?? null),null);
    if (remove) {
        assert.equal(await page.locator('#empty .image-ab-player').count(),0);
    } else {
        assert.deepEqual(await page.evaluate(()=>emptyNode.properties.image_ab_files[0]),{filename:'a.svg'});
        await page.evaluate(()=>releaseDecodes[1]());
        await page.waitForFunction(()=>emptyNode._imageABLocal?.[0]?.filename==='new.svg');
        assert.equal(await page.locator('#empty img').first().evaluate(image=>image.src),await page.evaluate(()=>createdURLs.at(-1)));
    }
}

async function testLifecycle(browser, url) {
    for (const [name, run] of [
        ['graph changes and restore',graphChanges], ['failed asset replacements',rejectedAssets],
        ['configure during decode',page=>pendingDecode(page,false)], ['remove during decode',page=>pendingDecode(page,true)],
    ]) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error=>errors.push(error.message));
        page.setDefaultTimeout(5000);
        try {
            await page.goto(url);
            await page.waitForFunction(()=>window.ready);
            await run(page);
            assert.equal(await page.evaluate(()=>uploadCount),0);
            assert.deepEqual(errors, []);
            console.log('PASS:',name);
        } catch (error) {throw new Error(name,{cause:error});}
        finally {await page.close();}
    }
}

(async () => {
    fs.mkdirSync(output, {recursive:true});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({channel:'chrome', headless:true});
    try {
        await testLifecycle(browser, `http://127.0.0.1:${server.address().port}/`);
        const page = await browser.newPage({viewport:{width:1100,height:900}});
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.ready && imageNode._imageABSignature && [...imageNode._imageAB.element.querySelectorAll('img')].every(image=>image.naturalWidth));
        const empty = page.locator('#empty'), images = page.locator('#images');
        assert.equal(await empty.locator('select').isVisible(), false);
        assert.equal(await empty.getByRole('button', {name:'Fullscreen',exact:true}).isVisible(), false);
        assert.equal(await empty.locator('.media-ab-stage').isVisible(), false);
        assert.equal(await empty.getByRole('status').isVisible(), false);
        assert.equal(await empty.getByRole('button').count(), 3, 'Only A, B and language are visible in the empty panel');
        assert.equal(await page.evaluate(()=>emptyNode.size[0]), 320);
        await page.waitForFunction(()=>imageNode._imageABHadPreview);
        assert.deepEqual(await page.evaluate(()=>imageNode.size), [760,520], 'First preview opens a regular image-sized panel');
        assert.equal(await page.evaluate(()=>imageNode._imageABWidget.width),760,'DOM widget width follows the expanded node');
        assert.equal(await page.evaluate(()=>imageNode._imageABWidget.options.hideOnZoom),false,'Preview must remain visible when zooming out');
        await page.evaluate(()=>{imageNode._imageABWidget.width=208;imageNode.setDirtyCanvas();});
        await page.waitForFunction(()=>imageNode._imageABWidget.width===760 && imageNode._imageAB.element.offsetWidth===740);
        assert.equal(await images.locator('.media-ab-stage').evaluate(stage=>stage.offsetWidth),740,'A stale 208px widget width must not squeeze the photo into a vertical strip');
        assert.equal(await page.evaluate(()=>imageNode.size.every(Number.isFinite)), true, 'Initial preview sizing must remain finite');
        assert((await empty.boundingBox()).height < 120);
        assert.equal(await empty.locator('.image-ab-player').getAttribute('lang'), 'en');
        assert.equal(await empty.getByRole('button', {name:'Select image A',exact:true}).textContent(), 'Select A');
        assert.equal(await empty.getByRole('button', {name:'Select image B',exact:true}).textContent(), 'Select B');
        assert.equal(await images.getByRole('button', {name:'Replace image A',exact:true}).textContent(), 'Replace A');
        assert.equal(await images.getByRole('button', {name:'Replace image B',exact:true}).textContent(), 'Replace B');
        await empty.getByRole('button', {name:'Switch to Chinese'}).click();
        assert.equal(await empty.getByRole('button', {name:'选择 A 图片',exact:true}).textContent(), '选择 A');
        assert.equal(await empty.getByRole('button', {name:'选择 B 图片',exact:true}).textContent(), '选择 B');
        assert.equal(await empty.locator('.title').textContent(), '图片A/B对比');
        assert.equal(await page.evaluate(()=>emptyNode.properties.image_ab_language), 'zh');
        await page.evaluate(()=>emptyNode.onConfigure());
        assert.equal(await empty.locator('.image-ab-player').getAttribute('lang'), 'zh-CN');

        await page.evaluate(()=>imageNode.setSize([640,500]));
        await page.waitForFunction(()=>imageNode._imageAB.element.offsetWidth===620);
        assert.equal(await images.locator('.media-ab-stage').evaluate(stage=>stage.offsetHeight>350), true, 'Preview must fill the height allocated by the resized node');
        assert.deepEqual(await page.evaluate(()=>imageNode.size), [640,500], 'Automatic layout must not undo a manual resize');
        assert.equal(await page.evaluate(()=>imageNode._imageABWidget.width),640,'Widget width must also follow manual node resizing');

        const initialHeight = (await images.boundingBox()).height;
        await images.getByRole('combobox').selectOption('side');
        await page.waitForFunction(()=>imageNode._imageAB.element.offsetHeight===imageNode.size[1]-60);
        assert.equal((await images.boundingBox()).height, initialHeight, 'Changing mode must preserve the manually chosen window size');
        await images.getByRole('combobox').selectOption('toggle');
        await images.getByRole('button', {name:'Show B',exact:true}).click();
        await images.getByRole('button', {name:'Switch to Chinese'}).click();
        assert.equal(await images.getByRole('button', {name:'替换 A 图片',exact:true}).textContent(), '替换 A');
        assert.equal(await images.getByRole('button', {name:'替换 B 图片',exact:true}).textContent(), '替换 B');
        assert.equal(await images.getByRole('combobox').inputValue(), 'toggle');
        assert.equal(await images.getByRole('button', {name:'显示 A',exact:true}).isVisible(), true);
        await page.evaluate(()=>imageNode.onExecuted({image_ab: clips}));
        await images.getByRole('button', {name:'替换 A 图片'}).waitFor();
        assert.equal(await images.getByRole('combobox').inputValue(), 'toggle');
        assert.equal(await images.locator('.image-ab-player').getAttribute('lang'), 'zh-CN');

        for (const width of [280, 320, 640]) {
            await page.evaluate(width=>imageNode.setSize([width,imageNode.size[1]]), width);
            for (const mode of ['slide','side','toggle']) {
                await images.getByRole('combobox').selectOption(mode);
                await page.waitForFunction(()=>imageNode._imageAB.element.offsetHeight===imageNode.size[1]-60);
                assert.equal(await images.locator('.image-ab-player').evaluate(root=>root.scrollWidth<=root.clientWidth), true, `No horizontal overflow at ${width}px / ${mode}`);
                assert.equal(await images.locator('.media-ab-toolbar').evaluate(toolbar=>toolbar.scrollWidth<=toolbar.clientWidth), true);
            }
        }
        await page.evaluate(()=>imageNode.setSize([320,imageNode.size[1]]));
        await images.getByRole('combobox').selectOption('slide');
        const stage = images.locator('.media-ab-stage'), rect = await stage.boundingBox();
        await page.mouse.move(rect.x+rect.width*.25, rect.y+rect.height*.5);
        await page.waitForFunction(()=>imageNode._imageAB.element.querySelector('.media-ab-stage').children[1].style.clipPath.includes('25%'));
        await page.mouse.down({button:'middle'}); await page.mouse.move(rect.x+rect.width*.25+40,rect.y+rect.height*.5+20); await page.mouse.up({button:'middle'});
        assert.deepEqual(await page.evaluate(()=>testApp.canvas.ds.offset), [20,10]);
        assert.equal(await stage.locator(':scope > div').nth(1).evaluate(pane=>pane.style.clipPath), 'inset(0px 0px 0px 25%)');

        await page.evaluate(()=>imageNode.onExecuted({image_ab:[null,clips[1]]}));
        await page.waitForFunction(()=>imageNode._imageAB.element.querySelectorAll('img')[1].naturalWidth);
        assert.equal(await images.getByRole('button', {name:'全屏',exact:true}).isVisible(), true);
        assert.equal(await images.getByRole('combobox').isDisabled(), true);
        assert.equal(await images.locator('.media-ab-stage > div').nth(1).evaluate(pane=>pane.style.clipPath), '');
        await page.evaluate(()=>imageNode.onExecuted({image_ab:[{filename:'portrait.svg'},clips[1]]}));
        await page.waitForFunction(()=>imageNode._imageAB.element.querySelector('img').naturalHeight===960);
        assert.deepEqual(await page.evaluate(()=>imageNode.size), [320,500], 'Loading a portrait must preserve the resized window');
        await page.evaluate(()=>imageNode.onExecuted({image_ab:clips}));
        await images.getByRole('button', {name:'替换 A 图片'}).waitFor();
        await page.waitForFunction(()=>imageNode._imageAB.element.offsetHeight===imageNode.size[1]-60);
        await page.screenshot({path:path.join(output,'minimal-image-ab.png')});

        const dropImage = (name, side, area='button') => empty.locator(area==='root'?'.image-ab-player':area==='stage'?'.media-ab-stage':side?'.image-ab-file-b':'.image-ab-file-a').evaluate((target,{name,side})=>{
            const root=target.closest('.image-ab-player');
            const dataTransfer=new DataTransfer();
            const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="blue"/></svg>';
            dataTransfer.items.add(new File([svg],name,{type:name.endsWith('.txt')?'text/plain':'image/svg+xml'}));
            const rect=target.getBoundingClientRect(), clientX=rect.left+rect.width*(side?0.75:0.25), clientY=rect.top+10;
            target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientX,clientY}));
            const hint={highlight:root.dataset.replaceSide,previousURL:emptyNode._imageABLocal?.[side]?.url,text:root.dataset.dropHint};
            target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX,clientY}));
            return hint;
        },{name,side});
        assert.equal((await dropImage('first.png',1,'root')).text,'松开填入图片 A');
        await page.waitForFunction(()=>emptyNode._imageAB.element.querySelector('img').naturalWidth && emptyNode._imageABHadPreview);
        assert.deepEqual(await page.evaluate(()=>emptyNode.size),[760,520],'Dropping the first file expands the compact node');
        assert.equal(await page.evaluate(()=>uploadCount),0,'Local files are decoded directly without uploading');
        await page.evaluate(()=>emptyNode.setSize([420,360]));
        assert.equal((await dropImage('second.png',0,'stage')).text,'松开填入图片 B');
        await page.waitForFunction(()=>emptyNode._imageAB.element.querySelectorAll('img')[1].naturalWidth);
        assert.deepEqual(await page.evaluate(()=>emptyNode.size),[420,360],'Adding B after a manual resize preserves that size');
        assert.equal(await empty.locator('[data-drop-hint]').count(),0,'Drop highlight is removed');
        assert.deepEqual(await page.evaluate(()=>emptyNode.properties.image_ab_files),[null,null]);
        assert.equal(await page.evaluate(()=>JSON.stringify(emptyNode.properties).includes('blob:')),false,'Transient URLs must never enter saved workflow properties');
        for(const scale of [1,0.5,1.5]) {
          await empty.locator('.mount').evaluate((mount,scale)=>{mount.style.transform=`scale(${scale})`;mount.style.transformOrigin='top left';},scale);
          for(const mode of ['slide','side','toggle']) {
            await empty.getByRole('combobox').selectOption(mode);
            if(mode==='toggle') await empty.getByRole('button',{name:'显示 B',exact:true}).click();
            for(const side of [0,1]) {
                const other=await page.evaluate(side=>emptyNode._imageABLocal[1-side].url,side);
                const name=`${mode}-${side}.png`;
                const hint=await dropImage(name,side,'stage');
                assert.equal(hint.highlight,side?'B':'A');
                assert.equal(hint.text,side?'松开替换图片 B':'松开替换图片 A');
                await page.waitForFunction(({side,previousURL})=>emptyNode._imageABLocal[side]?.url!==previousURL&&[...emptyNode._imageAB.element.querySelectorAll('img')].every(image=>image.naturalWidth),{side,previousURL:hint.previousURL});
                assert.equal(await page.evaluate(side=>emptyNode._imageABLocal[1-side].url,side),other,'Only the targeted side is replaced');
                assert.equal(await page.evaluate(url=>revokedURLs.includes(url),hint.previousURL),true,'Replacing a local file releases its old object URL');
                assert.equal(await empty.getByRole('combobox').inputValue(),mode,'File import preserves the selected comparison mode');
                assert.deepEqual(await page.evaluate(()=>emptyNode.size),[420,360]);
                assert.equal(await empty.locator('[data-drop-hint]').isVisible(),false);
            }
            const headerBefore=await page.evaluate(()=>emptyNode._imageABLocal[1].url);
            const handled=await page.evaluate(mode=>{
                const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="green"/></svg>';
                const dataTransfer=new DataTransfer();dataTransfer.items.add(new File([svg],mode+'-header.png',{type:'image/svg+xml'}));
                const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer});
                event.canvasX=emptyNode.pos[0]+emptyNode.size[0]*0.75;
                const over=emptyNode.onDragOver(event),drop=emptyNode.onDragDrop(event);
                return {over,drop};
            },mode);
            assert.deepEqual(handled,{over:true,drop:true},'Dropping on the node header must also be handled before ComfyUI imports workflow metadata');
            await page.waitForFunction(previous=>emptyNode._imageABLocal[1]?.url!==previous&&emptyNode._imageAB.element.querySelectorAll('img')[1].naturalWidth,headerBefore);
          }
        }
        await empty.locator('.mount').evaluate(mount=>mount.style.transform='');
        const localBeforeExecute=await page.evaluate(()=>emptyNode._imageABLocal.map(clip=>clip.url));
        await page.evaluate(()=>emptyNode.onExecuted({image_ab:clips}));
        await page.waitForFunction(()=>[...emptyNode._imageAB.element.querySelectorAll('img')].every(image=>image.naturalWidth));
        assert.deepEqual(await page.evaluate(()=>emptyNode._imageABLocal.map(clip=>clip.url)),localBeforeExecute,'Execution preserves local previews in the current page');
        assert.deepEqual(await page.evaluate(()=>emptyNode.properties.image_ab),[null,null]);
        assert.equal(await page.evaluate(()=>JSON.stringify(emptyNode.properties).includes('blob:')),false);
        const uploadsBeforeAssets=await page.evaluate(()=>uploadCount);
        const dropAsset = ({side=0, name='asset.png', uri=true, metadata=true, area='stage', kind='image', url=null, type='output', subfolder=''}) => page.evaluate(options=>{
            const {side,name,uri,metadata,area,kind,url,type,subfolder}=options, root=emptyNode._imageAB.element;
            const dataTransfer=new DataTransfer(), source=url||new URL('/view?'+new URLSearchParams({filename:name,type,subfolder}),location.href).href;
            if(metadata) dataTransfer.setData('application/x-comfy-asset-info',JSON.stringify({filename:name,type,subfolder,media_kind:kind,preview_url:source}));
            if(uri) dataTransfer.setData('text/uri-list',source);
            const target=root.querySelector('.media-ab-stage'), rect=target.getBoundingClientRect();
            const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:rect.left+rect.width*(side?0.75:0.25),clientY:rect.top+10});
            let handled;
            if(area==='header') {
                event.canvasX=emptyNode.pos[0]+emptyNode.size[0]*(side?0.75:0.25);
                handled=emptyNode.onDragOver(event);
                emptyNode.onDragDrop(event);
            } else {
                target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientX:event.clientX,clientY:event.clientY}));
                handled=root.dataset.replaceSide===(side?'B':'A');
                target.dispatchEvent(event);
            }
            return {handled,files:dataTransfer.files.length};
        },{side,name,uri,metadata,area,kind,url,type,subfolder});
        for(const mode of ['slide','side','toggle']) {
            await empty.getByRole('combobox').selectOption(mode);
            for(const side of [0,1]) {
                const other=await page.evaluate(side=>JSON.stringify(emptyNode.properties.image_ab_files[1-side]),side);
                const name=`generated-${mode}-${side}.png`;
                assert.deepEqual(await dropAsset({side,name}),{handled:true,files:0},'Asset cards contain metadata and a URI, not File objects');
                await page.waitForFunction(({side,name})=>emptyNode.properties.image_ab_files[side]?.filename===name&&emptyNode._imageAB.element.querySelectorAll('img')[side].naturalWidth,{side,name});
                assert.deepEqual(await page.evaluate(side=>emptyNode.properties.image_ab_files[side],side),{filename:name,subfolder:'',type:'output'});
                assert.equal(await page.evaluate(side=>JSON.stringify(emptyNode.properties.image_ab_files[1-side]),side),other);
                assert.equal(await empty.getByRole('combobox').inputValue(),mode);
                assert.deepEqual(await page.evaluate(()=>emptyNode.size),[420,360]);
            }
            const name=`generated-${mode}-header.png`;
            assert.deepEqual(await dropAsset({side:1,name,area:'header'}),{handled:true,files:0});
            await page.waitForFunction(name=>emptyNode.properties.image_ab_files[1].filename===name,name);
        }
        for(const source of [{name:'uri-only.png',metadata:false},{name:'metadata-only.png',uri:false}]) {
            await dropAsset(source);
            await page.waitForFunction(name=>emptyNode.properties.image_ab_files[0].filename===name,source.name);
        }
        for(const type of ['input','temp']) {
            await dropAsset({name:'nested/image.png',subfolder:'originals',type});
            await page.waitForFunction(type=>emptyNode.properties.image_ab_files[0].type===type&&emptyNode._imageAB.element.querySelector('img').naturalWidth,type);
            assert.deepEqual(await page.evaluate(()=>emptyNode.properties.image_ab_files[0]),{filename:'image.png',subfolder:'originals/nested',type});
        }
        const opaqueURL=new URL('/assets/generated/content',page.url()).href;
        await dropAsset({name:'asset.png',url:opaqueURL});
        await page.waitForFunction(()=>emptyNode.properties.image_ab_files[0].url==='/assets/generated/content'&&emptyNode._imageAB.element.querySelector('img').naturalWidth);
        await dropAsset({metadata:false,url:opaqueURL});
        await page.waitForFunction(()=>emptyNode.properties.image_ab_files[0].url==='/assets/generated/content'&&!emptyNode.properties.image_ab_files[0].filename&&emptyNode._imageAB.element.querySelector('img').naturalWidth);
        const savedReferences=await page.evaluate(()=>JSON.stringify(emptyNode.properties.image_ab_files));
        await page.evaluate(()=>{emptyNode.properties=JSON.parse(JSON.stringify(emptyNode.properties));emptyNode.onConfigure();});
        await page.waitForFunction(()=>emptyNode._imageABSignature&&[...emptyNode._imageAB.element.querySelectorAll('img')].every(image=>image.naturalWidth));
        await page.evaluate(()=>emptyNode.onExecuted({image_ab:clips}));
        await page.waitForFunction(()=>[...emptyNode._imageAB.element.querySelectorAll('img')].every(image=>image.naturalWidth));
        assert.equal(await page.evaluate(()=>JSON.stringify(emptyNode.properties.image_ab_files)),savedReferences,'Saved asset references survive restore and execution');
        assert.equal(await page.evaluate(()=>uploadCount),uploadsBeforeAssets,'Assets, view URLs and saved references must never upload or create image copies');
        assert.equal(await page.evaluate(urls=>urls.every(url=>revokedURLs.includes(url)),localBeforeExecute),true,'Replacing local previews with assets releases their URLs');
        const beforeRejectedAsset=await page.evaluate(()=>JSON.stringify(emptyNode.properties.image_ab_files));
        for(const source of [{kind:'video'},{url:'https://example.com/image.png'}]) {
            await dropAsset(source);
            await empty.getByRole('status').filter({hasText:'请选择图片文件'}).waitFor();
            assert.equal(await page.evaluate(()=>JSON.stringify(emptyNode.properties.image_ab_files)),beforeRejectedAsset);
        }
        await dropImage('temporary.png',0,'stage');
        await page.waitForFunction(()=>emptyNode._imageABLocal?.[0]&&emptyNode._imageAB.element.querySelector('img').naturalWidth);
        const temporaryURL=await page.evaluate(()=>emptyNode._imageABLocal[0].url);
        assert.equal(await page.evaluate(()=>emptyNode.properties.image_ab_files[0]),null,'A temporary preview clears the previous persisted reference for that side');
        await page.evaluate(()=>emptyNode.onConfigure());
        await page.waitForFunction(()=>emptyNode._imageABSignature&&emptyNode._imageAB.element.querySelectorAll('img')[1].naturalWidth);
        assert.equal(await page.evaluate(()=>emptyNode._imageABLocal),null,'Reopening the workflow clears session-only images');
        assert.equal(await page.evaluate(url=>revokedURLs.includes(url),temporaryURL),true);
        assert.equal(await empty.locator('img').first().evaluate(image=>image.hasAttribute('src')),false,'Reload never requests an expired blob URL');
        await dropImage('temporary-again.png',0,'stage');
        await page.waitForFunction(()=>emptyNode._imageABLocal?.[0]&&emptyNode._imageAB.element.querySelector('img').naturalWidth);
        const beforeCorrupt=await page.evaluate(()=>emptyNode._imageABLocal[0].url);
        await empty.locator('.media-ab-stage').evaluate(stage=>{
            const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['not an image'],'broken.png',{type:'image/png'}));
            const r=stage.getBoundingClientRect();stage.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer,clientX:r.left+5,clientY:r.top+5}));
        });
        await empty.getByRole('status').filter({hasText:'A 图片读取失败'}).waitFor();
        assert.equal(await page.evaluate(()=>emptyNode._imageABLocal[0].url),beforeCorrupt,'A corrupt file must preserve the working preview');
        assert.equal(await page.evaluate(()=>revokedURLs.includes(createdURLs.at(-1))),true,'A failed decode releases its temporary URL');
        const beforeInvalid=await page.evaluate(()=>JSON.stringify(emptyNode.properties.image_ab_files));
        await dropImage('invalid.txt',0,'stage');
        await empty.getByRole('status').filter({hasText:'请选择图片文件'}).waitFor();
        assert.equal(await page.evaluate(()=>JSON.stringify(emptyNode.properties.image_ab_files)),beforeInvalid,'Rejected files preserve the existing images');
        await empty.locator('.media-ab-stage').evaluate(stage=>{
            const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['image fixture'],'cancel.png',{type:'image/png'}));
            const rect=stage.getBoundingClientRect();
            stage.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer,clientX:rect.right-10,clientY:rect.top+10}));
            stage.dispatchEvent(new DragEvent('dragleave',{bubbles:true,relatedTarget:document.body}));
        });
        assert.equal(await empty.locator('[data-drop-hint]').isVisible(),false,'Leaving the node removes all drag feedback');

        await page.evaluate(()=>imageNode.onExecuted({image_ab:[{filename:'missing.svg'},null]}));
        await images.getByRole('status').filter({hasText:'图片读取失败'}).waitFor();
        await images.getByRole('button', {name:'Switch to English'}).click();
        assert.match(await images.getByRole('status').textContent(), /Cannot load image A/);
        await page.evaluate(()=>{imageNode.onRemoved(); emptyNode.onRemoved();});
        assert.equal(await page.locator('.image-ab-player').count(), 0);
        assert.equal(await page.evaluate(()=>createdURLs.every(url=>revokedURLs.includes(url))),true,'Replacing, reopening and deleting nodes must release every local object URL');
        assert.equal(await page.evaluate(()=>uploadCount),0,'Neither local previews nor asset references may upload images');
        assert.deepEqual(errors, []);
        console.log('PASS: local previews and asset references without uploads in all modes, no persisted blob URLs, preserved execution previews, object URL cleanup, reload behavior, corrupt-file rejection, sizing, language and canvas interactions.');
    } finally {await browser.close(); server.closeAllConnections(); server.close();}
})().catch(error=>{console.error(error); server.closeAllConnections(); server.close(); process.exitCode=1;});
