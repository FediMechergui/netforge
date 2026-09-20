/**
 * Writes apps/web/icons-gallery.html: every icon (per palette category + generic fallback) at 24 px
 * and 64 px, in a dark and a light panel using the app theme variable values. Run from apps/web:
 *   npx vite-node scripts/make-gallery.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IconDef } from '../src/catalog/icon-types.js';
import { escapeXml, iconToSvg } from '../src/catalog/render-svg.js';
import { GENERIC_VISUAL, ICON_GROUPS } from '../src/catalog/visuals.js';

const DARK = {
  '--bg': '#0f1216',
  '--bg-2': '#161a20',
  '--panel': '#1b2029',
  '--panel-2': '#212836',
  '--border': '#2a3140',
  '--border-strong': '#3a4356',
  '--text': '#e6e9ef',
  '--text-dim': '#8a93a5',
  '--text-faint': '#5d6678',
  '--accent': '#56b4e9',
  '--ok': '#009e73',
  '--warn': '#e69f00',
  '--err': '#d55e00',
  '--purple': '#cc79a7',
};
const LIGHT: typeof DARK = {
  '--bg': '#eef0f3',
  '--bg-2': '#f7f8fa',
  '--panel': '#ffffff',
  '--panel-2': '#f2f4f7',
  '--border': '#d3d8e0',
  '--border-strong': '#b7bfcb',
  '--text': '#1a1f28',
  '--text-dim': '#566073',
  '--text-faint': '#8791a2',
  '--accent': '#0072b2',
  '--ok': '#007a59',
  '--warn': '#a86f00',
  '--err': '#b04400',
  '--purple': '#a0507f',
};

const vars = (t: typeof DARK): string =>
  Object.entries(t)
    .map(([k, v]) => `${k}:${v};`)
    .join('');

function card(def: IconDef): string {
  return (
    `<figure class="card">` +
    `<div class="art"><span class="s24">${iconToSvg(def, { size: 24 })}</span>` +
    `<span class="s64">${iconToSvg(def, { size: 64, title: def.label })}</span></div>` +
    `<figcaption><code>${escapeXml(def.id)}</code><span>${escapeXml(def.label)}</span>` +
    `<small>${def.w}×${def.h} · ${def.shapes.length} shapes${def.badge ? ` · badge ${escapeXml(def.badge)}` : ''}</small>` +
    `</figcaption></figure>`
  );
}

function panel(name: string, theme: typeof DARK): string {
  const groups = [...ICON_GROUPS, { id: 'generic', label: 'Fallback', icons: [GENERIC_VISUAL] }];
  return (
    `<section class="panel" style="${vars(theme)}"><h2>${name} theme</h2>` +
    groups
      .map((g) => `<h3>${escapeXml(g.label)} <small>${g.icons.length}</small></h3><div class="grid">${g.icons.map(card).join('')}</div>`)
      .join('') +
    `</section>`
  );
}

const count = ICON_GROUPS.reduce((n, g) => n + g.icons.length, 0);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NetForge Icon Gallery</title>
<style>
:root{--sans:'Segoe UI','Inter','Noto Sans',system-ui,-apple-system,sans-serif}
body{margin:0;font-family:var(--sans);background:#0b0d10;color:#e6e9ef}
header{padding:20px 24px 4px}header h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:#8a93a5;font-size:13px}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:16px;padding:16px 24px 32px}
.panel{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px 16px 16px;min-width:0}
.panel h2{font-size:15px;margin:8px 0}.panel h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin:18px 0 8px}
.panel h3 small{color:var(--text-faint)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.card{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px}
.art{display:flex;align-items:center;gap:12px;min-height:72px;overflow:hidden}
.s24{flex:none;display:flex;align-items:center;padding:4px;border:1px dashed var(--border-strong);border-radius:4px}
.s64{flex:1;display:flex;justify-content:center;min-width:0}.s64 svg{max-width:100%;height:auto}
figcaption{display:flex;flex-direction:column;gap:2px;font-size:12px;margin-top:6px}
figcaption code{font-size:11px;color:var(--accent)}figcaption small{color:var(--text-faint);font-size:10.5px}
</style></head><body>
<header><h1>NetForge device icons</h1><p>${count} device icons + generic fallback, each at 24 px and 64 px height.</p></header>
<div class="panels">${panel('Dark', DARK)}${panel('Light', LIGHT)}</div>
</body></html>
`;

const out = fileURLToPath(new URL('../icons-gallery.html', import.meta.url));
writeFileSync(out, html);
console.log(`wrote ${out} (${count + 1} icons)`);
