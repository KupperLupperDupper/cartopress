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
  getLayer,
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
  { id: 'faded', label: 'Faded' },
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
export function planRender({ lat, lon, layerId, width, height, coverageKm }) {
  const layer = getLayer(layerId);
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
    tileCount: (x1 - x0 + 1) * (y1 - y0 + 1),
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

  await runPool(jobs, MAX_CONCURRENT_TILES, async ({ tx, ty }) => {
    if (signal && signal.aborted) return;

    const dx = tx * TILE_SIZE - left;
    const dy = ty * TILE_SIZE - top;

    // Rows outside the projection simply do not exist; columns wrap around.
    if (ty < 0 || ty >= worldTiles) {
      ctx.fillStyle = PLACEHOLDER_FILL;
      ctx.fillRect(dx, dy, TILE_SIZE, TILE_SIZE);
    } else {
      const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles;
      const url = buildTileUrl(layer, wrappedX, ty, zoom);
      const img = await loadTile(url, signal);
      if (img) {
        ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
      } else {
        failedTiles++;
        ctx.fillStyle = PLACEHOLDER_FILL;
        ctx.fillRect(dx, dy, TILE_SIZE, TILE_SIZE);
      }
    }

    loaded++;
    onProgress({ loaded, total: tileCount, phase: 'tiles' });
  });

  if (signal && signal.aborted) throw abortError();

  onProgress({ loaded: tileCount, total: tileCount, phase: 'compose' });
  const canvas = downscale(stage, width, height, filter);
  drawAttribution(canvas, layer.attribution);

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
    case 'faded':
      return 'contrast(0.9) saturate(0.72) brightness(1.06)';
    case 'duotone':
      return 'grayscale(1) contrast(1.06)';
    default:
      return '';
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
 * Burn the layer's attribution into the bottom-right corner. This is a
 * licensing requirement for every provider used here, not a watermark.
 */
function drawAttribution(canvas, text) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;

  const fontSize = clamp(Math.round(h * 0.016), 11, 40);
  ctx.font = `500 ${fontSize}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const padX = fontSize * 0.85;
  const padY = fontSize * 0.5;
  const textWidth = ctx.measureText(text).width;
  const pillW = textWidth + padX * 2;
  const pillH = fontSize + padY * 2;
  const margin = clamp(Math.round(Math.min(w, h) * 0.02), 8, 48);
  const x = w - margin - pillW;
  const y = h - margin - pillH;

  ctx.save();
  roundRect(ctx, x, y, pillW, pillH, pillH / 2);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.55)';
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fillText(text, x + padX, y + pillH / 2 + fontSize * 0.04);
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

/** Encode to PNG. Throws TaintedCanvasError if the canvas is cross-origin dirty. */
export function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    try {
      // Probe first: a tainted canvas fails here predictably, whereas toBlob
      // may either throw or hand back null depending on the browser.
      canvas.getContext('2d').getImageData(0, 0, 1, 1);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The browser could not encode the image.'));
      }, type);
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
