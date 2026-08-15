/**
 * render.js — offscreen tile stitcher.
 *
 * This does NOT screenshot the Leaflet DOM. It works out which tiles cover the
 * requested ground rectangle, fetches them directly, draws them onto a canvas
 * at native tile resolution, and only then downscales to the exact pixel size
 * the user asked for. That is what makes a 4K export genuinely sharper than a
 * 1080p one instead of being the same picture, bigger.
 */

import {
  TILE_SIZE,
  resolveLayer,
  buildTileUrl,
  lonToPixelX,
  latToPixelY,
  metersPerPixel,
  zoomForCoverage
} from './tiles.js';

/** Hard ceiling per canvas side — browsers refuse or silently blank out above this. */
const MAX_RENDER_SIDE = 8192;
const MAX_CONCURRENT_TILES = 6;
const TILE_ATTEMPTS = 3; // initial try + 2 retries
const PLACEHOLDER_FILL = '#242830';
const BACKDROP = '#12141a';

export const FILTERS = [
  { id: 'none', label: 'None' },
  { id: 'contrast', label: 'High contrast' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'faded', label: 'Faded' },
  { id: 'noir', label: 'Noir' },
  { id: 'duotone', label: 'Duotone' }
];

export class TaintedCanvasError extends Error {
  constructor() {
    super(
      'The tile server blocked cross-origin reads, so the image could not be ' +
        'saved. Try a different style — this usually means that provider did ' +
        'not send an Access-Control-Allow-Origin header for these tiles.'
    );
    this.name = 'TaintedCanvasError';
  }
}

/**
 * Work out the render geometry for a request without fetching anything.
 * Exposed separately so the UI can show zoom / detail figures live.
 */
export function planRender({
  lat,
  lon,
  layerId,
  labels = true,
  width,
  height,
  coverageKm
}) {
  const layer = resolveLayer(layerId, labels);
  const coverageMeters = Math.max(1, coverageKm * 1000);

  let zoom = zoomForCoverage(lat, width, coverageMeters, layer.maxZoom);
  let mpp = metersPerPixel(lat, zoom);
  let renderWidth = Math.round(coverageMeters / mpp);
  let renderHeight = Math.round(renderWidth * (height / width));

  // Step the zoom back down if the intermediate canvas would be unreasonable.
  while (
    zoom > 0 &&
    (renderWidth > MAX_RENDER_SIDE || renderHeight > MAX_RENDER_SIDE)
  ) {
    zoom -= 1;
    mpp = metersPerPixel(lat, zoom);
    renderWidth = Math.round(coverageMeters / mpp);
    renderHeight = Math.round(renderWidth * (height / width));
  }

  renderWidth = Math.max(1, renderWidth);
  renderHeight = Math.max(1, renderHeight);

  const centerX = lonToPixelX(lon, zoom);
  const centerY = latToPixelY(lat, zoom);
  const left = centerX - renderWidth / 2;
  const top = centerY - renderHeight / 2;

  const x0 = Math.floor(left / TILE_SIZE);
  const x1 = Math.floor((left + renderWidth - 1) / TILE_SIZE);
  const y0 = Math.floor(top / TILE_SIZE);
  const y1 = Math.floor((top + renderHeight - 1) / TILE_SIZE);

  const tilesPerPass = (x1 - x0 + 1) * (y1 - y0 + 1);
  const passes = 1 + layer.overlays.length;

  return {
    layer,
    zoom,
    coverageMeters,
    metersPerPixel: mpp,
    // Ground resolution of the *delivered* file, after downscaling.
    outputMetersPerPixel: coverageMeters / width,
    renderWidth,
    renderHeight,
    left,
    top,
    x0,
    x1,
    y0,
    y1,
    tilesPerPass,
    passes,
    tileCount: tilesPerPass * passes,
    clamped: zoom >= layer.maxZoom && renderWidth < width
  };
}

/**
 * Render an export. Resolves with `{ canvas, plan, failedTiles }`.
 * `onProgress({ loaded, total, phase })` is called as tiles arrive.
 */
export async function renderExport(options) {
  const {
    width,
    height,
    filter = 'none',
    caption = null,
    attribution = true,
    styleColors = {},
    onProgress = () => {},
    signal
  } = options;

  const plan = planRender(options);
  const {
    layer,
    zoom,
    renderWidth,
    renderHeight,
    left,
    top,
    x0,
    x1,
    y0,
    y1,
    tileCount
  } = plan;

  const stage = document.createElement('canvas');
  stage.width = renderWidth;
  stage.height = renderHeight;
  const ctx = stage.getContext('2d');
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, renderWidth, renderHeight);

  const worldTiles = Math.pow(2, zoom);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push({ tx, ty });
    }
  }

  let loaded = 0;
  let failedTiles = 0;
  onProgress({ loaded: 0, total: tileCount, phase: 'tiles' });

  // The basemap first, then any transparent label overlays on top of it.
  const passTemplates = [layer.url, ...layer.overlays];

  for (let pass = 0; pass < passTemplates.length; pass++) {
    const template = passTemplates[pass];
    const isOverlay = pass > 0;

    await runPool(jobs, MAX_CONCURRENT_TILES, async ({ tx, ty }) => {
      if (signal && signal.aborted) return;

      const dx = tx * TILE_SIZE - left;
      const dy = ty * TILE_SIZE - top;

      // Rows outside the projection do not exist; columns wrap around.
      if (ty < 0 || ty >= worldTiles) {
        if (!isOverlay) {
          ctx.fillStyle = PLACEHOLDER_FILL;
          ctx.fillRect(dx, dy, TILE_SIZE, TILE_SIZE);
        }
      } else {
        const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles;
        const url = buildTileUrl(template, wrappedX, ty, zoom, layer.subdomains);
        const img = await loadTile(url, signal);
        if (img) {
          ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
        } else {
          failedTiles++;
          // A missing label tile just means no labels there; only the basemap
          // is worth flagging with a placeholder.
          if (!isOverlay) {
            ctx.fillStyle = PLACEHOLDER_FILL;
            ctx.fillRect(dx, dy, TILE_SIZE, TILE_SIZE);
          }
        }
      }

      loaded++;
      onProgress({ loaded, total: tileCount, phase: 'tiles' });
    });

    if (signal && signal.aborted) throw abortError();
  }

  onProgress({ loaded: tileCount, total: tileCount, phase: 'compose' });
  const canvas = downscale(stage, width, height, filter);
  if (layer.pixelStyle) {
    // The layer's own palette sits between the style defaults and the caller's
    // overrides — Blueprint is the ink style with a different default palette.
    applyPixelStyle(canvas, layer.pixelStyle, {
      ...(layer.pixelColors || {}),
      ...styleColors
    });
  }
  drawCredits(canvas, attribution ? layer.attribution : null, caption);

  return { canvas, plan, failedTiles };
}

/* ------------------------------------------------------------------ */
/* Tile loading                                                        */
/* ------------------------------------------------------------------ */

function loadTile(url, signal) {
  return new Promise((resolve) => {
    let attempt = 0;

    const tryOnce = () => {
      if (signal && signal.aborted) return resolve(null);

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'sync';
      img.onload = () => resolve(img);
      img.onerror = () => {
        attempt++;
        if (attempt < TILE_ATTEMPTS) {
          setTimeout(tryOnce, 250 * attempt);
        } else {
          resolve(null); // caller paints a placeholder; never abort the render
        }
      };
      img.src = url;
    };

    tryOnce();
  });
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length))
    .fill(null)
    .map(async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await worker(item);
      }
    });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------ */
/* Compositing                                                         */
/* ------------------------------------------------------------------ */

function downscale(source, targetWidth, targetHeight, filter) {
  let current = source;

  // Halve in steps when the reduction is large — a single big downscale loses
  // fine detail even with high-quality smoothing on.
  while (
    current.width / 2 >= targetWidth &&
    current.height / 2 >= targetHeight &&
    current.width / 2 >= 1
  ) {
    const half = document.createElement('canvas');
    half.width = Math.max(1, Math.floor(current.width / 2));
    half.height = Math.max(1, Math.floor(current.height / 2));
    const hctx = half.getContext('2d');
    hctx.imageSmoothingEnabled = true;
    hctx.imageSmoothingQuality = 'high';
    hctx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }

  const out = document.createElement('canvas');
  out.width = targetWidth;
  out.height = targetHeight;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';

  const cssFilter = filterString(filter);
  if (cssFilter) octx.filter = cssFilter;
  octx.drawImage(current, 0, 0, targetWidth, targetHeight);
  octx.filter = 'none';

  if (filter === 'duotone') applyDuotone(out);
  if (filter === 'faded') {
    // A whisper of warm haze, so "faded" reads as film rather than washed out.
    octx.globalCompositeOperation = 'soft-light';
    octx.fillStyle = 'rgba(255, 214, 170, 0.16)';
    octx.fillRect(0, 0, targetWidth, targetHeight);
    octx.globalCompositeOperation = 'source-over';
  }

  return out;
}

function filterString(filter) {
  switch (filter) {
    case 'contrast':
      return 'contrast(1.16) saturate(1.12) brightness(1.02)';
    case 'vivid':
      return 'saturate(1.38) contrast(1.06)';
    case 'faded':
      return 'contrast(0.9) saturate(0.72) brightness(1.06)';
    case 'noir':
      return 'grayscale(1) contrast(1.24) brightness(0.98)';
    case 'duotone':
      return 'grayscale(1) contrast(1.06)';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ */
/* Neon                                                                */
/* ------------------------------------------------------------------ */

/**
 * These are luminance ramps, not filter chains.
 *
 * The dark basemap is only about 40 levels of grey deep, so pushing it around
 * with brightness/contrast crushes it into flat, banded colour. Instead,
 * normalise that narrow band to 0..1 and look the result up in a real gradient.
 * The same maths runs in the preview and in the export.
 *
 * Pixel styles: looks built by remapping the basemap's luminance rather than
 * by fetching differently-styled tiles. Each declares the colours it exposes to
 * the user and how to turn them into ramp stops.
 *
 * This is how the "line drawing" look is possible without a backend. The people
 * making those posters generally render OpenStreetMap *vector* data — prettymaps,
 * QGIS, or a Mapbox Studio style — which needs either a toolchain or an API key.
 * A dark raster basemap already encodes the road network as the bright part of a
 * very narrow luminance band, so mapping that band onto ink-on-paper gets to the
 * same place with nothing but a canvas.
 */
export const PIXEL_STYLES = {
  neon: {
    id: 'neon',
    glow: true,
    gamma: 0.7,
    // Where the ramp reaches the picked colour and holds it — see neonStops.
    exactFrom: 0.32,
    colors: [
      {
        key: 'glow',
        label: 'Glow',
        fallback: '#28baff',
        presets: ['#28baff', '#ff3ad0', '#4dff9b', '#ffa32e', '#bfe9ff', '#ff3b3b']
      }
    ],
    stops: (colors) => neonStops(colors.glow)
  },

  ink: {
    id: 'ink',
    glow: false,
    gamma: 0.85,
    colors: [
      {
        key: 'ink',
        label: 'Line',
        fallback: '#1b2430',
        presets: ['#1b2430', '#2f4a7a', '#7a2b2b', '#2b5f4a', '#000000', '#e8eef7']
      },
      {
        key: 'paper',
        label: 'Paper',
        fallback: '#f3ecdf',
        presets: ['#f3ecdf', '#ffffff', '#efe6d2', '#0d2b4f', '#101418', '#f7e9e3']
      }
    ],
    stops: (colors) => inkStops(colors.ink, colors.paper)
  }
};

/** Default colour set for a pixel style, as `{ key: hex }`. */
export function defaultStyleColors(styleId) {
  const style = PIXEL_STYLES[styleId];
  if (!style) return {};
  return style.colors.reduce((acc, slot) => {
    acc[slot.key] = slot.fallback;
    return acc;
  }, {});
}

/**
 * Black and white point of the source basemap, in 0..1 luminance.
 *
 * Measured rather than guessed: across CARTO dark tiles from dense city to open
 * country, the background sits around 9/255 and even the widest arterials only
 * reach about 42/255. The whole picture lives in a sliver at the bottom of the
 * range, which is exactly why naive brightness/contrast cannot rescue it.
 * These are fixed rather than auto-levelled per tile, so neighbouring tiles
 * cannot disagree about where black is and show a seam.
 */
const NEON_FLOOR = 0.032;
const NEON_CEIL = 0.17;

/**
 * Build the ramp stops from a single chosen colour.
 *
 * The chosen colour is used *exactly*, across the whole middle of the ramp —
 * which is where a street network actually lands, so the map reads as the
 * colour that was picked rather than a relative of it. Hue and saturation are
 * never altered; only lightness moves, down towards black for the background
 * and up towards white for the few brightest arterials.
 *
 * Earlier versions drifted the hue and clamped saturation to a floor, which is
 * how a lime pick came out blue and a muted pick came out neon.
 */
function neonStops(color) {
  const rgb = hexToRgb(color);
  const [h, s, l] = rgbToHsl(rgb);

  // Keep the ends usable even for a very dark or very pale pick, without
  // touching the colour itself in the band that dominates the image.
  const floor = Math.max(0.03, l * 0.1);
  const low = Math.max(0.1, l * 0.42);
  const peak = Math.min(0.95, Math.max(l * 1.5, l + 0.22));

  // The plateau covers everything from "faint side street" upwards, so the road
  // network renders at the picked colour itself rather than at some brighter or
  // darker relative of it. Only the background falls away below it, and only
  // the very brightest arterials lift above.
  return [
    { t: 0.0, c: hslToRgb(h, s, floor) },
    { t: 0.16, c: hslToRgb(h, s, low) },
    { t: 0.32, c: rgb }, // exactly the picked colour ...
    { t: 0.94, c: rgb }, // ... held across the whole street network
    { t: 1.0, c: hslToRgb(h, s * 0.6, peak) }
  ];
}

/**
 * Ink on paper: paper below the line threshold, the line colour above it, with
 * a short blend between so antialiased streets do not turn into jagged stencil
 * edges. Water sits just above the land background in the source, so it comes
 * through as a pale wash rather than disappearing.
 */
function inkStops(ink, paper) {
  const inkRgb = hexToRgb(ink);
  const paperRgb = hexToRgb(paper);
  return [
    { t: 0.0, c: paperRgb },
    { t: 0.14, c: paperRgb },
    { t: 0.55, c: inkRgb },
    { t: 1.0, c: inkRgb }
  ];
}

/** 256-entry lookup tables, cached per style+colour — then pure lookups. */
const rampCache = new Map();

function rampFor(styleId, colors) {
  const style = PIXEL_STYLES[styleId];
  if (!style) return null;

  const key = `${styleId}:${style.colors.map((c) => colors[c.key]).join(',')}`;
  const cached = rampCache.get(key);
  if (cached) return cached;

  const stops = style.stops(colors);
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = Math.pow(i / 255, style.gamma); // lift the midtones off the floor
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s].t && t <= stops[s + 1].t) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    const span = b.t - a.t || 1;
    const k = (t - a.t) / span;
    table[i * 3] = a.c[0] + (b.c[0] - a.c[0]) * k;
    table[i * 3 + 1] = a.c[1] + (b.c[1] - a.c[1]) * k;
    table[i * 3 + 2] = a.c[2] + (b.c[2] - a.c[2]) * k;
  }

  rampCache.set(key, table);
  return table;
}

/* --- small colour helpers ---------------------------------------- */

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) / 60 % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const t = hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  return t.map((v) => Math.round((v + m) * 255));
}

/**
 * Remap one canvas in place. Used on whole exports and on single preview tiles,
 * which is why it has to cope with a canvas of any size. Pass `glow: false` for
 * per-tile work — a blur applied tile by tile shows seams at the boundaries.
 */
export function applyPixelStyle(canvas, styleId, colors, options = {}) {
  const style = PIXEL_STYLES[styleId];
  if (!style) return;

  const palette = { ...defaultStyleColors(styleId), ...colors };
  const ramp = rampFor(styleId, palette);
  const glow = options.glow !== false && style.glow;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let image;
  try {
    image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (err) {
    return; // tainted; the export path reports this properly later
  }

  const px = image.data;
  const scale = 255 / (NEON_CEIL - NEON_FLOOR);
  // Keep each pixel's ramp position so the bloom below can be undone on the
  // road network itself.
  const levels = glow ? new Uint8Array(px.length / 4) : null;

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    // Rec. 601 luma is close enough and much cheaper than a colour-managed one.
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    let t = (lum - NEON_FLOOR) * scale;
    t = t < 0 ? 0 : t > 255 ? 255 : t;
    const level = t | 0;
    if (levels) levels[p] = level;
    const idx = level * 3;
    px[i] = ramp[idx];
    px[i + 1] = ramp[idx + 1];
    px[i + 2] = ramp[idx + 2];
  }
  ctx.putImageData(image, 0, 0);

  if (!glow) return;

  // Bloom: a blurred copy added back with 'lighter'. Done at a third scale —
  // it is a glow, nobody can tell, and it keeps 4K renders quick.
  const gw = Math.max(1, Math.round(canvas.width / 3));
  const gh = Math.max(1, Math.round(canvas.height / 3));
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = gw;
  glowCanvas.height = gh;
  const gctx = glowCanvas.getContext('2d');
  gctx.filter = `blur(${Math.max(1, Math.round(gh * 0.006))}px)`;
  gctx.drawImage(canvas, 0, 0, gw, gh);

  // Kept gentle: 'lighter' is additive, so a strong bloom would drag every lit
  // pixel towards white and away from the colour that was actually chosen.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(glowCanvas, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  // The bloom has just added light to the network as well as around it, which
  // would leave the roads a paler relative of the chosen colour. Paint the
  // ramp back over everything at or above the plateau: the halo survives in the
  // gaps, the lines themselves come out at exactly the colour that was picked.
  const exactFrom = Math.round((style.exactFrom || 1) * 255);
  if (exactFrom <= 255) {
    const after = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = after.data;
    for (let i = 0, p = 0; i < out.length; i += 4, p++) {
      const level = levels[p];
      if (level < exactFrom) continue;
      const idx = level * 3;
      out[i] = ramp[idx];
      out[i + 1] = ramp[idx + 1];
      out[i + 2] = ramp[idx + 2];
    }
    ctx.putImageData(after, 0, 0);
  }
}

/** Map luminance onto a deep-navy -> warm-amber ramp, blended back gently. */
function applyDuotone(canvas) {
  const ctx = canvas.getContext('2d');
  let data;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (err) {
    return; // tainted — leave the greyscale pass in place, export will report it
  }

  const shadow = [22, 28, 46];
  const highlight = [255, 190, 120];
  const mix = 0.78;
  const px = data.data;

  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] / 255; // already greyscale from the CSS filter pass
    for (let c = 0; c < 3; c++) {
      const toned = shadow[c] + (highlight[c] - shadow[c]) * l;
      px[i + c] = px[i + c] * (1 - mix) + toned * mix;
    }
  }
  ctx.putImageData(data, 0, 0);
}

/**
 * Burn the layer's attribution into the bottom-right corner, and an optional
 * caption into the bottom-left. The attribution is a licensing requirement for
 * every provider used here, not a watermark.
 */
function drawCredits(canvas, attribution, caption) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const fontSize = clamp(Math.round(h * 0.016), 11, 40);
  const margin = clamp(Math.round(Math.min(w, h) * 0.02), 8, 48);

  if (attribution) {
    drawPill(ctx, attribution, {
      fontSize,
      align: 'right',
      x: w - margin,
      y: h - margin
    });
  }

  if (caption) {
    drawPill(ctx, caption, {
      fontSize: Math.round(fontSize * 1.15),
      align: 'left',
      x: margin,
      y: h - margin
    });
  }
}

/** Draw one rounded, semi-transparent pill anchored at a bottom corner. */
function drawPill(ctx, text, { fontSize, align, x, y }) {
  ctx.save();
  ctx.font = `500 ${fontSize}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const padX = fontSize * 0.85;
  const padY = fontSize * 0.5;
  const pillW = ctx.measureText(text).width + padX * 2;
  const pillH = fontSize + padY * 2;
  const px = align === 'right' ? x - pillW : x;
  const py = y - pillH;

  roundRect(ctx, px, py, pillW, pillH, pillH / 2);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.55)';
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fillText(text, px + padX, py + pillH / 2 + fontSize * 0.04);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/** Encode the canvas. Throws TaintedCanvasError if it is cross-origin dirty. */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    try {
      // Probe first: a tainted canvas fails here predictably, whereas toBlob
      // may either throw or hand back null depending on the browser.
      canvas.getContext('2d').getImageData(0, 0, 1, 1);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('The browser could not encode the image.'));
        },
        type,
        quality
      );
    } catch (err) {
      if (err && (err.name === 'SecurityError' || /taint/i.test(err.message))) {
        reject(new TaintedCanvasError());
      } else {
        reject(err);
      }
    }
  });
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function abortError() {
  const err = new Error('Render cancelled');
  err.name = 'AbortError';
  return err;
}
