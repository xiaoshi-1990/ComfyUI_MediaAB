// Probe an ordinary unfragmented MP4. Skip media data by its declared size.
const MAX_MOVIE_BYTES = 8 * 1024 * 1024;

function typeAt(data, offset) {
    return String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
}

function boxHeader(data, offset, remaining) {
    let size = data.getUint32(offset), header = 8;
    if (size === 1) {
        size = Number(data.getBigUint64(offset + 8)); header = 16;
    } else if (!size) size = remaining;
    if (!Number.isSafeInteger(size) || size < header || size > remaining) throw new RangeError('Invalid box size');
    return {type:typeAt(data, offset + 4), size, header};
}

function children(data, type) {
    const matches = [];
    for (let offset = 0, count = 0; offset < data.byteLength; count++) {
        if (count >= 256) throw new RangeError('Too many boxes');
        const {type:name, size, header} = boxHeader(data, offset, data.byteLength - offset);
        if (name === type) matches.push(new DataView(data.buffer, data.byteOffset + offset + header, size - header));
        offset += size;
    }
    return matches;
}

function child(data, type) {
    const matches = children(data, type);
    if (matches.length > 1) throw new RangeError('Ambiguous box');
    return matches[0];
}

function videoRate(track, media) {
    const mdhd = child(media, 'mdhd'), version = mdhd.getUint8(0);
    if (version > 1) return null;
    const scale = mdhd.getUint32(version ? 20 : 12);
    const table = child(child(media, 'minf'), 'stbl'), times = child(table, 'stts');
    // A single run gives every decode sample the same duration.
    if (times.byteLength !== 16 || times.getUint32(0) || times.getUint32(4) !== 1) return null;
    const samples = times.getUint32(8), delta = times.getUint32(12);
    if (!scale || !samples || !delta) return null;

    let origin = 0;
    const edits = child(track, 'edts');
    if (edits) {
        const list = child(edits, 'elst');
        // A single normal-speed edit commonly removes the B-frame decode delay.
        if (list.byteLength !== 20 || list.getUint32(0) || list.getUint32(4) !== 1 || list.getInt32(16) !== 65536) return null;
        origin = list.getInt32(12);
        if (origin < 0) return null;
    }

    const offsets = child(table, 'ctts');
    if (!offsets) return origin === 0 ? scale / delta : null;
    // Decode cadence alone is insufficient with reordered frames. Check that
    // presentation timestamps cover every frame slot exactly once from time 0.
    const runs = offsets.getUint32(4), signed = offsets.getUint8(0);
    if (signed > 1 || offsets.byteLength !== 8 + runs * 8 || samples > 1000000) return null;
    const seen = new Uint8Array(samples);
    let decoded = 0;
    for (let i = 8; i < offsets.byteLength; i += 8) {
        const count = offsets.getUint32(i);
        const shift = signed ? offsets.getInt32(i + 4) : offsets.getUint32(i + 4);
        const first = decoded + (shift - origin) / delta;
        if (!count || !Number.isInteger(first) || first < 0 || first + count > samples) return null;
        for (let frame = first; frame < first + count; frame++) {
            if (seen[frame]) return null;
            seen[frame] = 1;
        }
        decoded += count;
    }
    return decoded === samples ? scale / delta : null;
}

export async function readLocalFrameRate(file) {
    try {
        for (let offset = 0, count = 0; count < 64 && offset < file.size; count++) {
            const bytes = await file.slice(offset, offset + 16).arrayBuffer();
            const {type, size, header} = boxHeader(new DataView(bytes), 0, file.size - offset);
            if (type === 'moov') {
                if (size > MAX_MOVIE_BYTES) return null;
                const movie = new DataView(await file.slice(offset + header, offset + size).arrayBuffer());
                if (child(movie, 'mvex')) return null;
                let rate = null;
                for (const track of children(movie, 'trak')) {
                    const media = child(track, 'mdia');
                    if (typeAt(child(media, 'hdlr'), 8) !== 'vide') continue;
                    if (rate !== null) return null;
                    rate = videoRate(track, media);
                    if (!rate) return null;
                }
                return rate;
            }
            offset += size;
        }
    } catch {
        // Unreadable or incomplete timing metadata leaves normal playback available.
    }
    return null;
}
