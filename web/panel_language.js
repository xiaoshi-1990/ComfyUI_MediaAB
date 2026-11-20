import { app } from '../../../scripts/app.js';

export function panelLanguage(saved) {
    if (saved === 'zh' || saved === 'en') return saved;
    const locale = app.ui?.settings?.getSettingValue?.('Comfy.Locale') || document.documentElement?.lang;
    return /^zh(?:$|[-_])/i.test(locale || '') ? 'zh' : 'en';
}

export function watchPanelLanguage(onChange) {
    const settings = app.ui?.settings;
    settings?.addEventListener?.('Comfy.Locale.change', onChange);
    return () => settings?.removeEventListener?.('Comfy.Locale.change', onChange);
}
