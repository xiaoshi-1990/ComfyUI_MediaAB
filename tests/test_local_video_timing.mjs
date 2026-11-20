import assert from 'node:assert/strict';
import test from 'node:test';
import {readLocalFrameRate} from '../web/local_video_timing.js';

function words(...values) {
    const data = Buffer.alloc(4 * values.length);
    values.forEach((value, i) => data.writeUInt32BE(value >>> 0, 4 * i));
    return data;
}

function box(type, ...parts) {
    const payload = Buffer.concat(parts);
    return Buffer.concat([words(8 + payload.length), Buffer.from(type), payload]);
}

function track({type = 'vide', scale = 60000, timing = [4, 1000], offsets, origin} = {}) {
    const stts = box('stts', words(0, timing.length / 2, ...timing));
    const ctts = offsets ? box('ctts', words(0, offsets.length / 2, ...offsets)) : Buffer.alloc(0);
    const edts = origin === undefined ? Buffer.alloc(0) :
        box('edts', box('elst', words(0, 1, 1000, origin, 65536)));
    return box('trak', edts, box('mdia', box('hdlr', words(0, 0), Buffer.from(type)),
        box('mdhd', words(0, 0, 0, scale)), box('minf', box('stbl', stts, ctts))));
}

test('reads constant video timing past a media payload without reading the whole file', async () => {
    const payload = box('mdat', Buffer.alloc(1024 * 1024));
    for (const [scale, delta] of [[24000,1000],[30000,1000],[60000,1000],[30000,1001]]) {
        const movie = box('moov', track({type:'soun'}), track({scale, timing:[100,delta]}));
        const file = new Blob([payload, movie]);
        const reads = [];
        const rate = await readLocalFrameRate({size:file.size, slice(start, end) {
            reads.push([start,end]); return file.slice(start,end);
        }});
        assert.equal(rate, scale / delta);
        assert.deepEqual(reads, [[0,16],[payload.length,payload.length+16],[payload.length+8,file.size]]);
    }
});

test('checks presentation timing for B-frames and rejects gaps or duplicate timestamps', async () => {
    const probe = (options) => readLocalFrameRate(new Blob([box('moov', track(options))]));
    // Four decode-order samples map to presentation slots 0, 3, 1, 2.
    assert.equal(await probe({origin:1000, offsets:[1,1000, 1,3000, 2,0]}), 60);
    assert.equal(await probe({origin:1000, offsets:[1,1000, 1,1500, 2,0]}), null);
    assert.equal(await probe({origin:1000, offsets:[1,1000, 1,2000, 2,0]}), null);
    assert.equal(await probe({origin:-1}), null);
    assert.equal(await probe({timing:[2,1000, 2,2000]}), null);
});

test('unknown, fragmented, ambiguous and oversized metadata return no rate', async () => {
    for (const bytes of [
        Buffer.from('other container'), box('moov', track(), box('mvex')),
        box('moov', track(), track()), box('moov', track({type:'soun'})), box('moov', words(100,0)),
    ]) assert.equal(await readLocalFrameRate(new Blob([bytes])), null);

    const size = 10 * 1024 * 1024;
    const header = new Blob([words(size), Buffer.from('moov'), words(0,0)]);
    const reads = [];
    assert.equal(await readLocalFrameRate({size, slice(start, end) {reads.push([start,end]); return header;}}), null);
    assert.deepEqual(reads, [[0,16]]);
});
