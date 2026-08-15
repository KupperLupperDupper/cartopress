/**
 * main.js — UI wiring: search, preview map, framing, and export.
 */

import { geocode, debounce, splitDisplayName } from './geocode.js';
import {
  LAYER_LIST,
  getLayer,
  metersPerPixel,
  EARTH_METERS_PER_PIXEL
} from './tiles.js';
import {
  FILTERS,
  planRender,
  renderExport,
  canvasToBlob,
  TaintedCanvasError
} from './render.js';

/* ------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------ */

const STORAGE_KEY = 'cityfromabove:last';

const RESOLUTIONS = [
  '1080x1080',
  '2048x2048',
  '1920x1080',
  '2560x1440',
  '3840x2160',
  '1080x1920'
];

const MIN_KM = 0.5;
const MAX_KM = 50;
const SLIDER_MAX = 1000;
const MAX_CUSTOM_SIDE = 6000;
const MIN_CUSTOM_SIDE = 64;

/** ~40 places that reward a look from directly above. */
const SURPRISE = [
  ['Barcelona, Spain', 41.3874, 2.1686],
  ['Paris, France', 48.8566, 2.3522],
  ['Venice, Italy', 45.4408, 12.3155],
  ['Amsterdam, Netherlands', 52.3676, 4.9041],
  ['Copenhagen, Denmark', 55.6761, 12.5683],
  ['Palmanova, Italy', 45.9053, 13.3097],
  ['Brasília, Brazil', -15.7939, -47.8828],
  ['Manhattan, New York', 40.7831, -73.9712],
  ['San Francisco, USA', 37.7749, -122.4194],
  ['Chicago, USA', 41.8781, -87.6298],
  ['Mexico City, Mexico', 19.4326, -99.1332],
  ['Havana, Cuba', 23.1136, -82.3666],
  ['Rio de Janeiro, Brazil', -22.9068, -43.1729],
  ['Buenos Aires, Argentina', -34.6037, -58.3816],
  ['Reykjavik, Iceland', 64.1466, -21.9426],
  ['Edinburgh, Scotland', 55.9533, -3.1883],
  ['Lisbon, Portugal', 38.7223, -9.1393],
  ['Marrakesh, Morocco', 31.6295, -7.9811],
  ['Cairo, Egypt', 30.0444, 31.2357],
  ['Cape Town, South Africa', -33.9249, 18.4241],
  ['Nairobi, Kenya', -1.2921, 36.8219],
  ['Istanbul, Turkey', 41.0082, 28.9784],
  ['Athens, Greece', 37.9838, 23.7275],
  ['Rome, Italy', 41.9028, 12.4964],
  ['Vienna, Austria', 48.2082, 16.3738],
  ['Prague, Czechia', 50.0755, 14.4378],
  ['Berlin, Germany', 52.52, 13.405],
  ['Stockholm, Sweden', 59.3293, 18.0686],
  ['Saint Petersburg, Russia', 59.9311, 30.3609],
  ['Dubai, UAE', 25.2048, 55.2708],
  ['Jaipur, India', 26.9124, 75.7873],
  ['Mumbai, India', 19.076, 72.8777],
  ['Kathmandu, Nepal', 27.7172, 85.324],
  ['Bangkok, Thailand', 13.7563, 100.5018],
  ['Singapore', 1.3521, 103.8198],
  ['Hong Kong', 22.3193, 114.1694],
  ['Shanghai, China', 31.2304, 121.4737],
  ['Kyoto, Japan', 35.0116, 135.7681],
  ['Tokyo, Japan', 35.6762, 139.6503],
  ['Sydney, Australia', -33.8688, 151.2093]
];

/* ------------------------------------------------------------------
   Element refs
   ------------------------------------------------------------------ */

const el = {
  map: document.getElementById('map'),
  frame: document.getElementById('frame'),
  frameBadge: document.getElementById('frameBadge'),
  placeName: document.getElementById('placeName'),
  placeMeta: document.getElementById('placeMeta'),
  fitFrame: document.getElementById('fitFrame'),
  search: document.getElementById('search'),
  searchSpinner: document.getElementById('searchSpinner'),
  results: document.getElementById('results'),
  styles: document.getElementById('styles'),
  resolution: document.getElementById('resolution'),
  customSize: document.getElementById('customSize'),
  customW: document.getElementById('customW'),
  customH: document.getElementById('customH'),
  coverage: document.getElementById('coverage'),
  coverageOut: document.getElementById('coverageOut'),
  detailHint: document.getElementById('detailHint'),
  filters: document.getElementById('filters'),
  generate: document.getElementById('generate'),
  generateLabel: document.getElementById('generateLabel'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  status: document.getElementById('status'),
  surprise: document.getElementById('surprise'),
  footerAttribution: document.getElementById('footerAttribution')
};

/* ------------------------------------------------------------------
   State
   ------------------------------------------------------------------ */

const state = {
  lat: 41.3874,
  lon: 2.1686,
  zoom: 13,
  placeName: 'Barcelona, Spain',
  layerId: 'satellite',
  width: 3840,
  height: 2160,
  coverageKm: 8,
  filter: 'none'
};

let map;
let tileLayer;
let rendering = false;
let suppressHashUpdate = false;
let activeResultIndex = -1;
let currentResults = [];
let searchAbort = null;

/* ------------------------------------------------------------------
   Coverage slider mapping (logarithmic so the fine end gets real travel)
   ------------------------------------------------------------------ */

const sliderToKm = (v) =>
  MIN_KM * Math.pow(MAX_KM / MIN_KM, Number(v) / SLIDER_MAX);

const kmToSlider = (km) =>
  Math.round(
    (Math.log(clamp(km, MIN_KM, MAX_KM) / MIN_KM) / Math.log(MAX_KM / MIN_KM)) *
      SLIDER_MAX
  );

/* ------------------------------------------------------------------
   Map
   ------------------------------------------------------------------ */

function initMap() {
  map = L.map(el.map, {
    center: [state.lat, state.lon],
    zoom: state.zoom,
    zoomControl: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    attributionControl: true
  });

  map.zoomControl.setPosition('bottomleft');
  applyTileLayer();

  map.on('move zoom', updateFrame);
  map.on('moveend zoomend', () => {
    const c = map.getCenter();
    state.lat = c.lat;
    state.lon = c.lng;
    state.zoom = map.getZoom();
    updateReadouts();
    writeHash();
  });
}

function applyTileLayer() {
  const layer = getLayer(state.layerId);
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(layer.url, {
    maxZoom: layer.maxZoom,
    maxNativeZoom: layer.maxZoom,
    subdomains: layer.subdomains || 'abc',
    attribution: layer.leafletAttribution,
    crossOrigin: 'anonymous'
  }).addTo(map);

  el.footerAttribution.textContent =
    `${layer.attribution} · Geocoding by Nominatim / OpenStreetMap.`;
}

/* ------------------------------------------------------------------
   Control construction
   ------------------------------------------------------------------ */

function buildStyleButtons() {
  el.styles.innerHTML = '';
  LAYER_LIST.forEach((layer) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'style-btn';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(layer.id === state.layerId));
    btn.dataset.layer = layer.id;
    btn.innerHTML =
      `<span class="style-swatch" style="background:${layer.swatch}"></span>` +
      `<span class="style-name"></span>`;
    btn.querySelector('.style-name').textContent = layer.label;
    btn.addEventListener('click', () => selectLayer(layer.id));
    el.styles.appendChild(btn);
  });
}

function buildFilterChips() {
  el.filters.innerHTML = '';
  FILTERS.forEach((f) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(f.id === state.filter));
    btn.dataset.filter = f.id;
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      state.filter = f.id;
      [...el.filters.children].forEach((c) =>
        c.setAttribute('aria-checked', String(c.dataset.filter === f.id))
      );
    });
    el.filters.appendChild(btn);
  });
}

function selectLayer(id) {
  state.layerId = id;
  [...el.styles.children].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.layer === id))
  );
  applyTileLayer();

  // Terrain tops out at zoom 17; keep the preview inside the layer's range.
  const layer = getLayer(id);
  if (map.getZoom() > layer.maxZoom) map.setZoom(layer.maxZoom);

  updateReadouts();
  writeHash();
}

/* ------------------------------------------------------------------
   Control bindings
   ------------------------------------------------------------------ */

function bindControls() {
  // --- Search -----------------------------------------------------
  const runSearch = debounce((q) => doSearch(q), 500);

  el.search.addEventListener('input', () => {
    const q = el.search.value.trim();
    activeResultIndex = -1;
    if (q.length < 2) {
      runSearch.cancel();
      hideResults();
      el.searchSpinner.hidden = true;
      return;
    }
    el.searchSpinner.hidden = false;
    runSearch(q);
  });

  el.search.addEventListener('keydown', (e) => {
    if (el.results.hidden || !currentResults.length) {
      if (e.key === 'Enter') {
        runSearch.cancel();
        doSearch(el.search.value.trim());
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseResult(currentResults[Math.max(0, activeResultIndex)]);
    } else if (e.key === 'Escape') {
      hideResults();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.field')) hideResults();
  });

  // --- Resolution -------------------------------------------------
  el.resolution.addEventListener('change', () => {
    const v = el.resolution.value;
    if (v === 'custom') {
      el.customSize.hidden = false;
      readCustomSize();
    } else {
      el.customSize.hidden = true;
      const [w, h] = v.split('x').map(Number);
      state.width = w;
      state.height = h;
    }
    updateEverything();
    fitFrame();
  });

  [el.customW, el.customH].forEach((input) => {
    input.addEventListener('input', () => {
      readCustomSize();
      updateEverything();
    });
    input.addEventListener('change', () => {
      input.value = clamp(
        Math.round(Number(input.value) || MIN_CUSTOM_SIDE),
        MIN_CUSTOM_SIDE,
        MAX_CUSTOM_SIDE
      );
      readCustomSize();
      updateEverything();
      fitFrame();
    });
  });

  // --- Coverage ---------------------------------------------------
  el.coverage.addEventListener('input', () => {
    state.coverageKm = sliderToKm(el.coverage.value);
    updateEverything();
  });
  el.coverage.addEventListener('change', () => {
    fitFrame();
    writeHash();
  });

  // --- Buttons ----------------------------------------------------
  el.fitFrame.addEventListener('click', fitFrame);
  el.surprise.addEventListener('click', surpriseMe);
  el.generate.addEventListener('click', generate);

  window.addEventListener('resize', updateFrame);
  window.addEventListener('hashchange', () => {
    if (suppressHashUpdate) return;
    if (readHash()) {
      syncControlsFromState();
      map.setView([state.lat, state.lon], state.zoom);
      applyTileLayer();
      updateEverything();
    }
  });
}

function readCustomSize() {
  state.width = clamp(
    Math.round(Number(el.customW.value) || MIN_CUSTOM_SIDE),
    MIN_CUSTOM_SIDE,
    MAX_CUSTOM_SIDE
  );
  state.height = clamp(
    Math.round(Number(el.customH.value) || MIN_CUSTOM_SIDE),
    MIN_CUSTOM_SIDE,
    MAX_CUSTOM_SIDE
  );
}

/* ------------------------------------------------------------------
   Search behaviour
   ------------------------------------------------------------------ */

async function doSearch(query) {
  if (!query || query.length < 2) return;

  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();

  el.searchSpinner.hidden = false;
  try {
    const results = await geocode(query, searchAbort.signal);
    currentResults = results;
    renderResults(results);
  } catch (err) {
    if (err.name === 'AbortError') return;
    renderResults(null, 'Could not reach the geocoder. Try again in a moment.');
  } finally {
    el.searchSpinner.hidden = true;
  }
}

function renderResults(results, errorMessage) {
  el.results.innerHTML = '';
  activeResultIndex = -1;

  if (errorMessage || !results || !results.length) {
    const li = document.createElement('li');
    li.className = 'r-empty';
    li.textContent = errorMessage || 'No matches found.';
    el.results.appendChild(li);
    showResults();
    return;
  }

  results.forEach((r, i) => {
    const { primary, secondary } = splitDisplayName(r.name);
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);

    const a = document.createElement('span');
    a.className = 'r-primary';
    a.textContent = primary;
    const b = document.createElement('span');
    b.className = 'r-secondary';
    b.textContent = secondary || `${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`;

    li.append(a, b);
    li.addEventListener('click', () => chooseResult(r));
    el.results.appendChild(li);
  });

  showResults();
}

function moveActive(delta) {
  const items = [...el.results.querySelectorAll('li[role="option"]')];
  if (!items.length) return;
  activeResultIndex =
    (activeResultIndex + delta + items.length) % items.length;
  items.forEach((li, i) =>
    li.setAttribute('aria-selected', String(i === activeResultIndex))
  );
  items[activeResultIndex].scrollIntoView({ block: 'nearest' });
}

function chooseResult(result) {
  if (!result) return;
  state.lat = result.lat;
  state.lon = result.lon;
  state.placeName = result.name;
  el.search.value = splitDisplayName(result.name).primary;
  hideResults();
  saveLast();

  map.setView([result.lat, result.lon], map.getZoom());
  fitFrame();
  updateEverything();
}

function showResults() {
  el.results.hidden = false;
  el.search.setAttribute('aria-expanded', 'true');
}

function hideResults() {
  el.results.hidden = true;
  el.search.setAttribute('aria-expanded', 'false');
}

function surpriseMe() {
  const pick = SURPRISE[Math.floor(Math.random() * SURPRISE.length)];
  const [name, lat, lon] = pick;
  state.lat = lat;
  state.lon = lon;
  state.placeName = name;
  el.search.value = name.split(',')[0];
  hideResults();
  saveLast();
  map.setView([lat, lon], map.getZoom());
  fitFrame();
  updateEverything();
}

/* ------------------------------------------------------------------
   Framing + readouts
   ------------------------------------------------------------------ */

/** Size the overlay rectangle to the ground area that will be exported. */
function updateFrame() {
  const zoom = map.getZoom();
  const center = map.getCenter();
  const mpp = metersPerPixel(center.lat, zoom);
  const widthPx = (state.coverageKm * 1000) / mpp;
  const heightPx = widthPx * (state.height / state.width);
  const size = map.getSize();

  el.frame.style.aspectRatio = 'auto';
  el.frame.style.width = `${widthPx}px`;
  el.frame.style.height = `${heightPx}px`;
  el.frame.classList.toggle(
    'oversized',
    widthPx > size.x - 8 || heightPx > size.y - 8
  );
  el.frameBadge.textContent = `${state.width} × ${state.height}`;
}

/** Zoom the preview so the export frame sits comfortably inside the view. */
function fitFrame() {
  if (!map) return;
  const size = map.getSize();
  const aspect = state.height / state.width;
  const targetPx = Math.min(size.x * 0.78, (size.y * 0.78) / aspect);
  const mpp = (state.coverageKm * 1000) / targetPx;
  const lat = map.getCenter().lat;
  const layer = getLayer(state.layerId);
  const zoom = Math.log2(
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp
  );
  map.setZoom(clamp(zoom, 1, layer.maxZoom));
  updateFrame();
}

function updateReadouts() {
  const plan = planRender(state);
  const gsd = plan.outputMetersPerPixel;
  const gsdText = gsd < 1 ? `${(gsd * 100).toFixed(0)} cm/px` : `${gsd.toFixed(1)} m/px`;

  el.coverageOut.textContent = `${formatKm(state.coverageKm)} km`;
  el.detailHint.textContent =
    `${gsdText} in the export · source zoom ${plan.zoom} · ${plan.tileCount} tiles`;

  el.placeName.textContent = state.placeName || 'Custom location';
  el.placeMeta.textContent =
    `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)} · ` +
    `${formatKm(state.coverageKm)} km wide · ${getLayer(state.layerId).label}`;

  if (plan.clamped) {
    el.detailHint.textContent +=
      ` · ${getLayer(state.layerId).label} has no detail past zoom ${plan.layer.maxZoom}`;
  }
}

function updateEverything() {
  updateFrame();
  updateReadouts();
  writeHash();
}

/* ------------------------------------------------------------------
   Export
   ------------------------------------------------------------------ */

async function generate() {
  if (rendering) return;
  rendering = true;

  el.generate.disabled = true;
  el.generateLabel.textContent = 'Rendering…';
  el.progress.hidden = false;
  setStatus('');
  setProgress(0, 'Working out tile coverage…');

  try {
    const { canvas, plan, failedTiles } = await renderExport({
      lat: state.lat,
      lon: state.lon,
      layerId: state.layerId,
      width: state.width,
      height: state.height,
      coverageKm: state.coverageKm,
      filter: state.filter,
      onProgress: ({ loaded, total, phase }) => {
        if (phase === 'compose') {
          setProgress(1, 'Composing and downscaling…');
        } else {
          setProgress(total ? loaded / total : 0, `Loading tile ${loaded} / ${total}`);
        }
      }
    });

    setProgress(1, 'Encoding PNG…');
    const blob = await canvasToBlob(canvas);
    downloadBlob(blob, buildFilename());

    const size = (blob.size / 1024 / 1024).toFixed(1);
    const note = failedTiles
      ? ` ${failedTiles} tile${failedTiles === 1 ? '' : 's'} could not be loaded and were left blank.`
      : '';
    setStatus(
      `Saved ${state.width} × ${state.height} from ${plan.tileCount} tiles at zoom ${plan.zoom} (${size} MB).${note}`,
      failedTiles ? 'error' : 'ok'
    );
  } catch (err) {
    if (err instanceof TaintedCanvasError) {
      setStatus(err.message, 'error');
    } else if (err && err.name === 'AbortError') {
      setStatus('Render cancelled.');
    } else {
      console.error(err);
      setStatus(
        `Render failed: ${err && err.message ? err.message : 'unknown error'}`,
        'error'
      );
    }
  } finally {
    rendering = false;
    el.generate.disabled = false;
    el.generateLabel.textContent = 'Generate & Download';
    el.progress.hidden = true;
  }
}

function buildFilename() {
  const base = slugify(
    (state.placeName || 'map').split(',')[0] || 'map'
  );
  return `${base || 'map'}-${state.width}x${state.height}.png`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function setProgress(fraction, text) {
  el.progressBar.style.width = `${clamp(fraction * 100, 0, 100)}%`;
  el.progressText.textContent = text;
}

function setStatus(message, kind) {
  el.status.hidden = !message;
  el.status.textContent = message;
  el.status.classList.toggle('is-error', kind === 'error');
  el.status.classList.toggle('is-ok', kind === 'ok');
}

/* ------------------------------------------------------------------
   Persistence: URL hash + localStorage
   ------------------------------------------------------------------ */

/** Map pans fire constantly; batch the history writes so Safari stays happy. */
let hashTimer = null;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHashNow, 220);
}

function writeHashNow() {
  const hash =
    `#${state.lat.toFixed(5)},${state.lon.toFixed(5)},` +
    `${Number(state.zoom).toFixed(2)},${state.layerId},` +
    `${state.width}x${state.height},${state.coverageKm.toFixed(2)}`;
  if (hash === location.hash) return;
  suppressHashUpdate = true;
  history.replaceState(null, '', hash);
  setTimeout(() => {
    suppressHashUpdate = false;
  }, 0);
}

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return false;

  const [lat, lon, zoom, style, resolution, coverage] = raw.split(',');
  const latN = parseFloat(lat);
  const lonN = parseFloat(lon);
  if (!isFinite(latN) || !isFinite(lonN)) return false;

  state.lat = clamp(latN, -85, 85);
  state.lon = clamp(lonN, -180, 180);
  state.zoom = clamp(parseFloat(zoom) || 13, 1, 19);
  if (style && getLayer(style).id === style) state.layerId = style;

  if (resolution && /^\d+x\d+$/.test(resolution)) {
    const [w, h] = resolution.split('x').map(Number);
    state.width = clamp(w, MIN_CUSTOM_SIDE, MAX_CUSTOM_SIDE);
    state.height = clamp(h, MIN_CUSTOM_SIDE, MAX_CUSTOM_SIDE);
  }

  const cov = parseFloat(coverage);
  if (isFinite(cov)) state.coverageKm = clamp(cov, MIN_KM, MAX_KM);

  state.placeName = 'Shared view';
  return true;
}

/** Returns 'hash', 'storage', or null depending on where the view came from. */
function restoreState() {
  if (readHash()) return 'hash';

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && isFinite(saved.lat) && isFinite(saved.lon)) {
      state.lat = saved.lat;
      state.lon = saved.lon;
      state.placeName = saved.placeName || state.placeName;
      if (saved.query) el.search.value = saved.query;
      return 'storage';
    }
  } catch (err) {
    /* corrupt or unavailable storage — fall back to the default view */
  }
  return null;
}

function saveLast() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        query: el.search.value,
        placeName: state.placeName,
        lat: state.lat,
        lon: state.lon
      })
    );
  } catch (err) {
    /* private mode / quota — not worth surfacing */
  }
}

/* ------------------------------------------------------------------
   Misc helpers
   ------------------------------------------------------------------ */

function syncControlsFromState() {
  const preset = `${state.width}x${state.height}`;
  if (RESOLUTIONS.includes(preset)) {
    el.resolution.value = preset;
    el.customSize.hidden = true;
  } else {
    el.resolution.value = 'custom';
    el.customSize.hidden = false;
    el.customW.value = state.width;
    el.customH.value = state.height;
  }

  el.coverage.value = kmToSlider(state.coverageKm);

  [...el.styles.children].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.layer === state.layerId))
  );
  [...el.filters.children].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.filter === state.filter))
  );
}

function formatKm(km) {
  return km < 10 ? km.toFixed(1) : km.toFixed(0);
}

function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // 'Malmö' -> 'malmo'
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ------------------------------------------------------------------
   Boot — last, so nothing runs before its module bindings exist
   ------------------------------------------------------------------ */

const restoredFrom = restoreState();
buildStyleButtons();
buildFilterChips();
initMap();
bindControls();
syncControlsFromState();
updateEverything();
// A shared link carries its own zoom; anything else should open already framed.
if (restoredFrom !== 'hash') fitFrame();
