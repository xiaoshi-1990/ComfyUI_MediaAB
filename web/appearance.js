export function applyAppearance(root) {
    if (!document.getElementById('media-ab-appearance')) {
        const style = document.createElement('style'); style.id = 'media-ab-appearance';
        style.textContent = `
        .media-ab{--ab-bg:#08090a;--ab-fg:#dadbde;--ab-muted:#777d86;--ab-line:#202329;--ab-hover:#171b20;--ab-accent:#a9bacf;--ab-radius:0px;width:100%;box-sizing:border-box;background:var(--ab-bg);color:var(--ab-fg);font:12px/1.5 system-ui,sans-serif;padding:6px;border:1px solid transparent;border-radius:var(--ab-radius);color-scheme:dark}
        .media-ab{display:flex;flex-direction:column}
        .media-ab .media-ab-stage{order:0}
        .media-ab .media-ab-divider{position:absolute;top:0;bottom:0;width:1px;transform-origin:left center;background:white;pointer-events:none;z-index:3}
        .media-ab .media-ab-toolbar{order:1;margin:8px 0 0}
        .media-ab .media-ab-transport{order:2}
        .media-ab .media-ab-info{order:4}
        .media-ab *{box-sizing:border-box}
        .media-ab button,.media-ab select{font:inherit;color:var(--ab-fg);background:transparent;border:1px solid transparent;border-radius:3px;padding:4px 7px;min-height:28px;cursor:pointer;box-shadow:none}
        .media-ab button:hover,.media-ab select:hover{background:var(--ab-hover)}
        .media-ab select option{color:var(--ab-fg);background:var(--ab-bg)}
        .media-ab button:disabled,.media-ab select:disabled{opacity:.35;cursor:default}
        .media-ab button:focus-visible,.media-ab select:focus-visible,.media-ab input:focus-visible{outline:1px solid var(--ab-accent);outline-offset:2px}
        .media-ab button[aria-pressed=true]{color:var(--ab-accent);background:var(--ab-hover)}
        .media-ab .media-ab-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:6px}
        .media-ab .ve-import-status{font-size:11px;color:var(--ab-muted);overflow-wrap:anywhere}
        .media-ab .ve-import-status[data-kind=error]{color:#df766e}
        .media-ab .ve-import-status[data-kind=success]{color:#80b49a}
        .media-ab .ve-uploading{opacity:.5}
        .media-ab .media-ab-stage{position:relative;overflow:hidden;background:#090b0d;aspect-ratio:16/9;touch-action:pan-y}
        .media-ab.image-ab-player{background:transparent;padding:0;border:0;gap:6px}
        .image-ab-player [hidden]{display:none!important}
        .image-ab-player .media-ab-toolbar{gap:4px;margin:0}
        .image-ab-player button,.image-ab-player select{min-height:28px;padding:3px 6px;font-size:11px;white-space:nowrap}
        .image-ab-player select{min-width:0;max-width:100%}
        .image-ab-player .image-ab-language,.ve-ab-player .video-ab-language{margin-left:auto;color:var(--ab-muted);font-size:10px}
        .media-ab.image-ab-player .media-ab-info{margin:0;overflow-wrap:anywhere}
        .image-ab-mount{width:100%;height:100%;min-height:0}
        .image-ab-mount>.image-ab-player{height:100%;min-height:0}
        .image-ab-mount .media-ab-stage{flex:1 1 0;min-height:0;aspect-ratio:auto!important}
        .image-ab-mount .media-ab-toolbar,.image-ab-mount .media-ab-info{flex-shrink:0}
        .media-ab video,.media-ab img{background:#090b0d;object-fit:contain;width:100%;height:100%;display:block}
        .media-ab-sources{order:-1;display:flex;align-items:center;flex:none;gap:12px;padding:2px 4px;color:var(--ab-fg);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
        .media-ab-sources>div{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1;white-space:nowrap}
        .media-ab-sources>div:last-child{justify-content:flex-end;margin-left:auto;text-align:right}
        .media-ab-sources b{color:var(--ab-accent);font-size:10px}
        .media-ab-filename{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ab-muted)}
        .media-ab .media-ab-transport{display:flex;align-items:center;gap:6px;margin-top:6px}
        .media-ab .media-ab-transport button{font-size:11px;white-space:nowrap}
        .media-ab .media-ab-info{margin-top:5px;font-size:10px;color:var(--ab-muted)!important}
        .media-ab input[type=range]{appearance:none;-webkit-appearance:none;accent-color:var(--ab-accent);background:transparent;min-width:0;height:24px;cursor:pointer;touch-action:none}
        .media-ab input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--ab-line)}
        .media-ab input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:8px;height:8px;margin-top:-3px;border-radius:50%;background:var(--ab-accent)}
        .media-ab input[type=range]::-moz-range-track{height:2px;background:var(--ab-line)}
        .media-ab input[type=range]::-moz-range-thumb{width:8px;height:8px;border:0;border-radius:50%;background:var(--ab-accent)}
        .ve-ab-player [hidden]{display:none!important}
        .video-ab-mount,.video-ab-mount>.ve-ab-player{width:100%;height:100%;min-height:0}
        .ve-ab-player .media-ab-stage{flex:1 1 0;min-height:0;aspect-ratio:auto}
        .ve-ab-player .media-ab-toolbar,.ve-ab-player .media-ab-transport{flex-shrink:0;flex-wrap:wrap;margin:2px 0;gap:4px}
        .ve-ab-player input[type=range]{min-width:60px}
        .ve-ab-player .ve-notices{order:3;overflow-wrap:anywhere}
        .ve-ab-player .ve-playback-status{overflow-wrap:anywhere}
        .media-ab[data-drop-hint]{position:relative;outline:1px dashed var(--ab-accent)}
        .media-ab[data-drop-hint]::after{content:attr(data-drop-hint);position:absolute;inset:0;display:grid;place-items:center;background:#151d26dd;color:var(--ab-fg);pointer-events:none;z-index:4}
        .media-ab[data-replace-side=A]::after{right:50%}
        .media-ab[data-replace-side=B]::after{left:50%}
        .media-ab[data-replace-side=A] button[data-side=A],.media-ab[data-replace-side=B] button[data-side=B]{outline:1px solid var(--ab-accent)}
        .media-ab:fullscreen{display:flex;flex-direction:column;padding:14px;max-height:100vh}
        .media-ab:fullscreen .media-ab-stage{flex:1;min-height:0;aspect-ratio:auto!important}
        `;
        document.head.append(style);
    }
}
