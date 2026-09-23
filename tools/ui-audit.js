// meet. UI audit — paste into the browser console on any screen.
// Reports text under 14px, contrast below WCAG AA, uppercase text,
// interactive targets under 44px and controls without an accessible name.
// Colours the browser reports as oklch()/color() cannot be converted here;
// they are listed under "checkByHand" (Prism identity hues are ~10:1 by design).
(() => {
    const lum = (c) => {
        const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const alpha = (c) => { const m = c.match(/[\d.]+/g); return m.length > 3 ? +m[3] : 1; };
    const bgOf = (el) => {
        for (let e = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (isRgb(c) && alpha(c) > 0.5) return c;
        }
        return 'rgb(10, 11, 16)';
    };
    const isRgb = (c) => /^rgba?\(/.test(c);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const out = { smallText: new Set(), lowContrast: new Set(), uppercase: new Set(), smallTargets: new Set(), unnamed: new Set(), checkByHand: new Set() };

    document.querySelectorAll('body *').forEach((el) => {
        if (el.closest('.px-bg, .prism-bg, svg')) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const key = (el.id ? '#' + el.id : el.tagName.toLowerCase()) + (el.classList[0] ? '.' + el.classList[0] : '');
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (hasText) {
            const fs = parseFloat(cs.fontSize);
            if (fs < 14) out.smallText.add(`${key} ${fs}px`);
            if (!isRgb(cs.color)) {
                out.checkByHand.add(key);
            } else {
                const cr = ratio(cs.color, bgOf(el));
                const large = fs >= 18.66 || (fs >= 14 && +cs.fontWeight >= 700);
                if (cr < (large ? 3 : 4.5)) out.lowContrast.add(`${key} ${cr.toFixed(2)}:1`);
            }
            if (cs.textTransform === 'uppercase') out.uppercase.add(key);
        }
        if (el.matches('button, a[href], input:not([type=file]), [role=button]')) {
            if ((r.width < 44 || r.height < 44) && !el.matches('.touch-shield')) out.smallTargets.add(`${key} ${Math.round(r.width)}x${Math.round(r.height)}`);
            const name = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent.trim() || el.title;
            if (!name) out.unnamed.add(key);
        }
    });

    const result = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
    console.table(Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])));
    return result;
})();
