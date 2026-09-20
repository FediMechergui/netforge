# icons — NetForge device artwork

One declarative `IconDef` per `DeviceIconId` (`packages/engine/src/contracts/catalog.ts` `DEVICE_ICONS`)
plus a generic fallback. One file per palette category (`DEVICE_CATEGORIES`), mirroring
`packages/engine/src/device/catalog/*.ts`; `generic.ts` holds the fallback.

| File | Role |
| --- | --- |
| `../catalog/icon-types.ts` | Pinned drawing language: `IconDef`, `IconShape`, `IconPaint`, `IconStyle`, `IconPalette`. |
| `../catalog/shared.ts` | Path-subset parser, arc normalisation, shape bounds, badge layout, theme colour tables. |
| `../catalog/render-svg.ts` | `iconToSvg` / `iconToDataUri` (DOM: palette, inspector, menus). Paints with CSS variables. |
| `../catalog/render-pixi.ts` | `drawIcon(g, def, palette, scale)`, `paletteFromCss`, `badgeLayout` (PixiJS v8 canvas). |
| `../catalog/validate.ts` | `validateIcon(def)` → list of problems (bounds with stroke, counts, badge, path subset). |
| `../catalog/visuals.ts` | `DEVICE_VISUALS`, `GENERIC_VISUAL`, `KIND_DEFAULT_ICON`, `ICON_GROUPS`, capability badges, `resolveVisual` / `visualForModel`. Throws at load on a missing/duplicated/unknown id. |
| `*.ts` (this folder) | Artwork, one file per palette category, plus `generic.ts`. |
| `../../test/visuals.test.ts` | Registry, renderer, parser and validator tests. |
| `../../scripts/make-gallery.ts` → `../../icons-gallery.html` | Review page: every icon at 24 px and 64 px, dark and light panels. |

Commands (from `apps/web`):

```sh
npx vitest run test/visuals.test.ts
npx vite-node scripts/make-gallery.ts   # rewrites icons-gallery.html
```

## Style guide

- **Flat, technical, calm.** No gradients, shadows or text inside the artwork.
- **Body:** `fill: 'face'`, `stroke: 'line'`, `strokeWidth: 2`, `join: 'round'`. Secondary parts
  (antennas, rack ears, panels) may use `line` at 1.5 or `face2` recesses.
- **Details:** `dim` at 1.25 (outlined ports, thin rules) or 1.5 (lines, vents). Nothing thinner than 1.25.
  Small filled `dim` blocks/dots (r ≥ 1) are fine for port rows and LEDs.
- **Accent:** exactly ONE distinguishing motif in `accent` (routing arrows, radio arcs, bolt, beam,
  sparkle, eye…). A motif may use several shapes (an arrow plus its head). Arrowheads: filled polygon
  with a 1.25 accent stroke for rounded tips.
- **accent2:** at most once per icon, only to separate near-identical icons (currently unused).
- **Corners:** boxes r 3–6 (slim 1U bodies r 3, desktop bodies r 5, routers r 6); small parts r 1–2.5;
  pills (AP puck) may be fully round.
- **Size classes** (w × h, centred on 0,0, stroke fully inside, `max(w, h) ≤ 96`):
  switch-like 88 × 30 (data-centre 88 × 36 with the accent outside the slim body); router-like
  64 × 44 to 72 × 48; tall chassis/towers up to 56 × 80; end devices 44–60 × 40–50; mobile
  30 × 50; cloud 84 × 50.
- **Legibility:** strong silhouette at 24 px, ≤ ~25 shapes (validator hard cap 30). Coordinates on a 0.5 grid.
- **Badges:** optional `badge` (≤ 4 chars: `L3`, `PoE`, `DSL`, `PON`) drawn as a pill in the
  bottom-right corner of the box. Keep that corner free of artwork on badged icons. Icons listed in
  `BADGE_READY_ICONS` may show a capability badge (`CAPABILITY_BADGES`) instead of their own, never
  longer than their own.
- **Look-alikes** must differ by silhouette or motif, never colour alone (spec §8.5); the badge is a
  final text distinction.
- **Original artwork only.** No vendor stencils (round router puck with four arrows, flat switch with
  crossing arrows, brick-wall-with-flame firewall, …).

## Adding an icon

1. Add the id to `DEVICE_ICONS` in the engine contract (an engine change; coordinate it).
2. Add an `IconDef` to the category file in this folder (typed, no casts), following the style guide.
3. If a new `DeviceKind` is added, map it in `KIND_DEFAULT_ICON` (TypeScript enforces completeness).
4. Run the tests (the registry test fails on a missing or duplicate id; every icon is validated and
   rendered), regenerate the gallery and review it in both themes at 24 px.
