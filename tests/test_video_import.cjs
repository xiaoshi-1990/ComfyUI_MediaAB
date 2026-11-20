// Run with Playwright and Chrome installed: node tests/test_video_import.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');

// A 16x16 black VP8 frame in a WebM container.
const frame = Buffer.from(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIG7TbuMU6uEElTDZ1OsggEI7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmlSrXsYMPQkBNgIRMYXZmV0GETGF2ZhZUrmvIrgEAAAAAAAA/14EBc8WIAAAAAAAAAAGcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBElTDZ6xzc6ljwItjxYgAAAAAAAAAAWfImEWjh0VOQ09ERVJEh4tMYXZjIGxpYnZweB9DtnWo54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiJmEiAICAAwNYAD+/6tQgA==',
    'base64');
const origin = 'http://media-ab.test';
const clip = filename => ({filename, type:'output', subfolder:'nested folder', version:'rev+2'});

(async () => {
    const browser = await chromium.launch({channel:'chrome'});
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let stalledRoute;
        await page.route(origin + '/**', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/') return route.fulfill({contentType:'text/html', body:'<!doctype html><body></body>'});
            if (url.pathname.startsWith('/web/')) return route.fulfill({
                path:path.join(__dirname, '../web', path.basename(url.pathname)),
                contentType:url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
            });
            if (url.pathname === '/scripts/app.js') return route.fulfill({contentType:'text/javascript',
                body:'export const app = {registerExtension(e) {window.extension = e;}};'});
            if (url.pathname === '/scripts/api.js') return route.fulfill({contentType:'text/javascript',
                body:"export const api = {apiURL: p => '/api'+p, fetchApi: (p, o) => fetch('/api'+p, o)};"});
            if (url.pathname.endsWith('/compare_preview')) {
                const {sources} = route.request().postDataJSON();
                return route.fulfill({json:{video_ab:sources.map(s => s && clip(s.file.split('/').pop())), errors:[null,null]}});
            }
            if (url.pathname === '/api/view') {
                const name = url.searchParams.get('filename');
                if (name === 'missing.webm') return route.fulfill({status:404});
                if (name === 'pending.webm') {stalledRoute = route; return;}
                return route.fulfill({contentType:'video/webm', body:name === 'corrupt.webm' ? 'invalid video' : frame});
            }
            return route.fulfill({status:404});
        });
        await page.goto(origin);
        await page.evaluate(async () => {
            await import('/web/video_ab.js');
            class TestNode {
                properties = {};
                inputs = [{name:'video_a', link:7}, {name:'video_b', link:null}];
                widgets = [{name:'video_a', value:'saved.webm'}, {name:'video_b', value:''}];
                graph = {links:{7:{origin_id:1}}, getNodeById:() => ({
                    id:1, type:'LoadVideo', widgets:[{name:'file', value:'original.webm'}],
                }), change() {}};
                size = [340,200];
                disconnectInput(i) {delete this.graph.links[this.inputs[i].link]; this.inputs[i].link = null;}
                addDOMWidget(name, type, element) {document.body.append(element); return {};}
                computeSize() {return this.size;}
                setSize(size) {this.size = size;}
                setDirtyCanvas() {}
            }
            await extension.beforeRegisterNodeDef(TestNode, {name:'VideoEditCompare',
                input:{required:{video_a:['VIDEO'], video_b:['VIDEO']}}});
            window.node = new TestNode();
            node.onNodeCreated();
        });
        const video = page.locator('video.ve-original').first();
        await page.waitForFunction(() => document.querySelector('video.ve-original')?.videoWidth === 16);
        const original = await video.elementHandle();
        const snapshot = () => page.evaluate(() => ({
            inputs:node.inputs, links:node.graph.links, path:node.widgets[0].value, clips:node.properties.video_ab,
        }));
        const before = await snapshot();
        const drop = name => page.locator('button[data-side="A"]').evaluate((button, filename) => {
            const transfer = new DataTransfer();
            transfer.setData('application/x-comfy-asset-info', JSON.stringify({filename, subfolder:'nested folder', type:'output'}));
            button.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
        }, name);
        const viewURL = name => origin + '/api/view?' + new URLSearchParams({
            filename:name, subfolder:'nested folder', type:'output', v:'rev+2',
        });
        for (const name of ['missing.webm', 'corrupt.webm']) {
            await Promise.all([page.waitForResponse(viewURL(name)), drop(name)]);
            await page.waitForFunction(() => !node._videoABUpload);
            assert.deepEqual(await snapshot(), before, name + ' must preserve the widget, clip and link');
            assert(await original.evaluate(v => v.isConnected && v.videoWidth === 16));
            await page.locator('.ve-import-status[data-kind="error"]').waitFor();
        }
        await Promise.all([page.waitForRequest(viewURL('good.webm')), drop('good.webm')]);
        await page.waitForFunction(() => node.inputs[0].link === null && document.querySelector('video.ve-original').videoWidth === 16);
        assert.equal(await video.evaluate(v => v.currentSrc), viewURL('good.webm'));
        assert.equal((await snapshot()).path, 'output/nested folder/good.webm');

        const committed = await snapshot();
        await Promise.all([page.waitForRequest(viewURL('pending.webm')), drop('pending.webm')]);
        await page.evaluate(() => node.onRemoved());
        await page.waitForFunction(() => !node._videoABUpload, null, {timeout:3000});
        await stalledRoute.fulfill({status:404});
        assert.deepEqual(await snapshot(), committed, 'removing the node must abort the pending replacement');
        assert.deepEqual(errors, []);
        console.log('PASS: failed views and corrupt media preserve the wired source, a decoded asset replaces it, and removal aborts a stalled import.');
    } finally {
        await browser.close();
    }
})().catch(error => {console.error(error); process.exitCode = 1;});
