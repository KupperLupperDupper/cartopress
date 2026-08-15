/**
 * main.js — UI wiring: search, preview map, framing, and export.
 */

import { geocode, debounce, splitDisplayName } from './geocode.js';
import {
  LAYER_GROUPS,
  getLayer,
  resolveLayer,
  supportsLabelToggle,
  buildTileUrl,
  lonToPixelX,
  latToPixelY,
  metersPerPixel,
  TILE_SIZE,
  EARTH_METERS_PER_PIXEL
} from './tiles.js';
import {
  FILTERS,
  planRender,
  renderExport,
  canvasToBlob,
  applyPixelStyle,
  PIXEL_STYLES,
  defaultStyleColors,
  TaintedCanvasError
} from './render.js';

/**
 * A tile layer that draws each tile into a canvas and runs the layer's pixel
 * treatment over it, so styles like Neon and Line drawing preview through
 * exactly the same code the exporter uses. Bloom is left to the exporter —
 * blurring per tile would show seams at the tile boundaries.
 */
const PixelTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const size = this.getTileSize().x;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      tile.getContext('2d').drawImage(img, 0, 0, size, size);
      applyPixelStyle(tile, this.options.pixelStyle, this.options.styleColors, {
        glow: false
      });
      done(null, tile);
    };
    img.onerror = (err) => done(err, tile);
    img.src = this.getTileUrl(coords);

    return tile;
  }
});

/* ------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------ */

const STORAGE_KEY = 'cartopress:last';

/** Pre-rename key, read once so an existing user keeps their last place. */
const LEGACY_STORAGE_KEY = 'cityfromabove:last';

/** Shown when a link carries coordinates but no name we can trust. */
const SHARED_VIEW_NAME = 'Shared view';

/** Every preset the dropdown offers, so custom sizes can be detected. */
const RESOLUTIONS = [
  '1080x1080',
  '1440x1440',
  '2048x2048',
  '4096x4096',
  '1920x1080',
  '2560x1440',
  '3840x2160',
  '5120x2880',
  '1080x1920',
  '1290x2796',
  '2160x2700',
  '2480x3508',
  '3508x4961',
  '5400x3600'
];

/**
 * Download formats. JPG and JPEG are the same encoder — they differ only in
 * the extension written to disk, which some tools and print shops care about.
 */
const FORMATS = [
  { id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', lossy: false },
  { id: 'jpg', label: 'JPG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
  { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpeg', lossy: true },
  { id: 'webp', label: 'WEBP', mime: 'image/webp', ext: 'webp', lossy: true }
];

const MIN_KM = 0.5;
/**
 * Wide enough for any country, Russia included, and getting on for a quarter of
 * the globe. The slider is logarithmic, which is what keeps a range this broad
 * usable: a little under half its travel is still spent between 0.5 and 50 km,
 * where most framing happens.
 */
const MAX_KM = 10000;

const UNITS_KEY = 'cartopress:units';

/**
 * Distance units. Everything is computed in metres; these only affect display.
 * Ground resolution gets its own ladder per system, so the number on screen
 * stays a readable size from a 13 cm/px city block to a 1.3 km/px continent.
 */
const UNITS = {
  km: {
    id: 'km',
    label: 'km',
    distance: (km) => ({ value: km, suffix: 'km' }),
    resolution: (m) =>
      m < 1
        ? { value: m * 100, digits: 0, suffix: 'cm/px' }
        : m < 1000
          ? { value: m, digits: 1, suffix: 'm/px' }
          : { value: m / 1000, digits: 2, suffix: 'km/px' }
  },
  mi: {
    id: 'mi',
    label: 'mi',
    distance: (km) => ({ value: km * 0.621371, suffix: 'mi' }),
    resolution: (m) =>
      m < 0.3048
        ? { value: m * 39.3701, digits: 0, suffix: 'in/px' }
        : m < 1609.344
          ? { value: m * 3.28084, digits: 1, suffix: 'ft/px' }
          : { value: m / 1609.344, digits: 2, suffix: 'mi/px' }
  }
};
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
  units: document.getElementById('units'),
  detailHint: document.getElementById('detailHint'),
  filters: document.getElementById('filters'),
  labels: document.getElementById('labels'),
  labelsSwitch: document.getElementById('labelsSwitch'),
  labelsHint: document.getElementById('labelsHint'),
  styleColours: document.getElementById('styleColours'),
  swapOrientation: document.getElementById('swapOrientation'),
  formats: document.getElementById('formats'),
  formatHint: document.getElementById('formatHint'),
  qualityField: document.getElementById('qualityField'),
  quality: document.getElementById('quality'),
  qualityOut: document.getElementById('qualityOut'),
  captionToggle: document.getElementById('captionToggle'),
  captionText: document.getElementById('captionText'),
  attributionToggle: document.getElementById('attributionToggle'),
  pickLocation: document.getElementById('pickLocation'),
  pickLocationSwitch: document.getElementById('pickLocationSwitch'),
  saveHint: document.getElementById('saveHint'),
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
  labels: false,
  width: 3840,
  height: 2160,
  coverageKm: 8,
  units: 'km', // replaced at boot by preferredUnits()
  filter: 'none',
  format: 'png',
  quality: 0.92,
  caption: false,
  captionText: '',
  attribution: true,
  pickLocation: false,
  styleColors: {} // per layer id, only for layers with a pixel style
};

/** Only Chromium browsers can offer a real save dialog to a static page. */
const CAN_PICK_LOCATION = typeof window.showSaveFilePicker === 'function';

let map;
let tileLayer;
let overlayLayers = [];
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
    scheduleThumbnailRefresh();
  });
}

function applyTileLayer() {
  const layer = resolveLayer(state.layerId, state.labels);

  if (tileLayer) map.removeLayer(tileLayer);
  overlayLayers.forEach((l) => map.removeLayer(l));
  overlayLayers = [];

  const common = {
    maxZoom: layer.maxZoom,
    maxNativeZoom: layer.maxZoom,
    subdomains: layer.subdomains || 'abc',
    crossOrigin: 'anonymous'
  };

  const baseOptions = { ...common, attribution: layer.leafletAttribution };
  tileLayer = layer.pixelStyle
    ? new PixelTileLayer(layer.url, {
        ...baseOptions,
        pixelStyle: layer.pixelStyle,
        styleColors: activeStyleColors()
      })
    : L.tileLayer(layer.url, baseOptions);
  tileLayer.addTo(map);

  // Label overlays sit on top of the basemap in the same pane.
  overlayLayers = layer.overlays.map((url, i) =>
    L.tileLayer(url, { ...common, zIndex: 10 + i }).addTo(map)
  );

  el.footerAttribution.textContent =
    `${layer.attribution} · Geocoding by Nominatim / OpenStreetMap.`;
}

/* ------------------------------------------------------------------
   Control construction
   ------------------------------------------------------------------ */

function buildStyleButtons() {
  el.styles.innerHTML = '';

  Object.entries(LAYER_GROUPS).forEach(([group, layers]) => {
    const heading = document.createElement('p');
    heading.className = 'style-group';
    heading.textContent = group;
    el.styles.appendChild(heading);

    layers.forEach((layer) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'style-btn';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(layer.id === state.layerId));
      btn.title = layer.label;
      btn.dataset.layer = layer.id;
      btn.innerHTML =
        `<span class="style-swatch" style="background-image:${layer.swatch}"></span>` +
        `<span class="style-name"></span>`;
      btn.querySelector('.style-name').textContent = layer.label;
      btn.addEventListener('click', () => selectLayer(layer.id));
      el.styles.appendChild(btn);
    });
  });
}

/**
 * Repaint each style swatch with a real tile of wherever the user is looking,
 * so the picker previews the actual place rather than an abstract colour chip.
 */
function refreshStyleThumbnails() {
  const center = map.getCenter();

  [...el.styles.querySelectorAll('.style-btn')].forEach((btn) => {
    const base = getLayer(btn.dataset.layer);
    const layer = resolveLayer(btn.dataset.layer, state.labels);
    const zoom = Math.min(12, layer.maxZoom);
    const x = Math.floor(lonToPixelX(center.lng, zoom) / TILE_SIZE);
    const y = Math.floor(latToPixelY(center.lat, zoom) / TILE_SIZE);
    const url = buildTileUrl(layer.url, x, y, zoom, layer.subdomains);

    const swatch = btn.querySelector('.style-swatch');
    const key = base.pixelStyle
      ? `${url}|${JSON.stringify(activeStyleColors(base.id))}`
      : url;
    if (swatch.dataset.key === key) return;
    swatch.dataset.key = key;

    if (base.pixelStyle) {
      // Run the thumbnail through the same treatment as the map, so the swatch
      // shows the style's actual colours rather than the raw dark basemap.
      paintPixelStyleSwatch(swatch, url, base);
    } else {
      // The gradient stays behind the tile as a fallback if the request fails.
      swatch.style.backgroundImage = `url("${url}"), ${base.swatch}`;
    }
  });
}

function paintPixelStyleSwatch(swatch, url, layer) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    canvas.getContext('2d').drawImage(img, 0, 0, 64, 64);
    applyPixelStyle(canvas, layer.pixelStyle, activeStyleColors(layer.id), {
      glow: false
    });
    try {
      swatch.style.backgroundImage = `url("${canvas.toDataURL()}"), ${layer.swatch}`;
    } catch (err) {
      swatch.style.backgroundImage = layer.swatch;
    }
  };
  img.onerror = () => {
    swatch.style.backgroundImage = layer.swatch;
  };
  img.src = url;
}

/** Debounced so a long pan does not fire a dozen thumbnail requests per style. */
let thumbTimer = null;
function scheduleThumbnailRefresh() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(refreshStyleThumbnails, 700);
}

/**
 * The colours in play for the current style: the style's own defaults, then the
 * layer's overrides (Blueprint is the ink style in different colours), then
 * whatever the user has picked for that layer.
 */
function activeStyleColors(layerId = state.layerId) {
  const layer = getLayer(layerId);
  if (!layer.pixelStyle) return {};
  return {
    ...defaultStyleColors(layer.pixelStyle),
    ...(layer.pixelColors || {}),
    ...(state.styleColors[layerId] || {})
  };
}

/** Build one labelled row of preset dots plus a colour input per colour slot. */
function buildStyleColorRows() {
  const layer = getLayer(state.layerId);
  el.styleColours.hidden = !layer.pixelStyle;
  el.styleColours.innerHTML = '';
  if (!layer.pixelStyle) return;

  const style = PIXEL_STYLES[layer.pixelStyle];
  const current = activeStyleColors();

  style.colors.forEach((slot) => {
    const row = document.createElement('div');
    row.className = 'colour-slot';

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = `${slot.label} colour`;

    const dots = document.createElement('div');
    dots.className = 'swatch-row';
    dots.setAttribute('role', 'radiogroup');
    dots.setAttribute('aria-label', `${slot.label} colour`);

    // A layer's own default belongs in its preset row even if the style's
    // generic list does not mention it — Blueprint's navy, for instance.
    const presets = [...new Set([
      ...(layer.pixelColors && layer.pixelColors[slot.key]
        ? [layer.pixelColors[slot.key]]
        : []),
      ...slot.presets
    ])];

    presets.forEach((color) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'colour-dot';
      dot.setAttribute('role', 'radio');
      dot.setAttribute('aria-label', color);
      dot.dataset.colour = color;
      dot.dataset.slot = slot.key;
      dot.title = color;
      // `color` drives the CSS glow, `background` the dot itself.
      dot.style.color = color;
      dot.style.background = color;
      dot.addEventListener('click', () => setStyleColor(slot.key, color));
      dots.appendChild(dot);
    });

    const custom = document.createElement('label');
    custom.className = 'colour-custom';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current[slot.key];
    input.dataset.slot = slot.key;
    input.addEventListener('input', () => setStyleColor(slot.key, input.value));
    const text = document.createElement('span');
    text.textContent = 'Custom';
    custom.append(input, text);

    row.append(label, dots, custom);
    el.styleColours.appendChild(row);
  });

  markActiveColors();
}

function markActiveColors() {
  const current = activeStyleColors();
  el.styleColours.querySelectorAll('.colour-dot').forEach((dot) => {
    const active =
      (current[dot.dataset.slot] || '').toLowerCase() ===
      dot.dataset.colour.toLowerCase();
    dot.setAttribute('aria-checked', String(active));
  });
  el.styleColours.querySelectorAll('input[type="color"]').forEach((input) => {
    const value = current[input.dataset.slot];
    if (value && input.value.toLowerCase() !== value.toLowerCase()) {
      input.value = value;
    }
  });
}

let colourRepaintTimer = null;

function setStyleColor(slotKey, color) {
  const existing = state.styleColors[state.layerId] || {};
  state.styleColors[state.layerId] = { ...existing, [slotKey]: color };
  markActiveColors();

  // Dragging a colour input fires continuously, and each repaint rebuilds every
  // tile — so reflect the choice at once but coalesce the actual work.
  clearTimeout(colourRepaintTimer);
  colourRepaintTimer = setTimeout(() => {
    // Tiles are cached with their colours already baked in, so the preview
    // layer has to be rebuilt rather than merely redrawn.
    applyTileLayer();
    refreshStyleThumbnails();
    writeHash();
  }, 120);
}

function buildFormatChips() {
  el.formats.innerHTML = '';
  FORMATS.forEach((f) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    btn.dataset.format = f.id;
    btn.textContent = f.label;

    if (!formatSupported(f)) {
      btn.disabled = true;
      btn.title = `${f.label} encoding is not supported by this browser`;
      btn.style.opacity = '0.4';
    } else {
      btn.addEventListener('click', () => selectFormat(f.id));
    }
    el.formats.appendChild(btn);
  });
  selectFormat(state.format);
}

/** Canvas encoders vary by browser; ask before offering the option. */
function formatSupported(format) {
  if (format.mime === 'image/png' || format.mime === 'image/jpeg') return true;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  return probe.toDataURL(format.mime).startsWith(`data:${format.mime}`);
}

function selectFormat(id) {
  const format = FORMATS.find((f) => f.id === id) || FORMATS[0];
  state.format = format.id;

  [...el.formats.children].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.format === format.id))
  );
  el.qualityField.hidden = !format.lossy;
  el.formatHint.textContent = format.lossy
    ? format.id === 'webp'
      ? 'WEBP: much smaller than PNG at similar quality.'
      : 'JPG and JPEG are the same encoder — only the file extension differs.'
    : 'PNG is lossless, and by far the largest file.';
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
  [...el.styles.querySelectorAll('.style-btn')].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.layer === id))
  );

  updateLabelSwitch();
  buildStyleColorRows();
  applyTileLayer();

  // Several layers top out below 19; keep the preview inside the range.
  const layer = getLayer(id);
  if (map.getZoom() > layer.maxZoom) map.setZoom(layer.maxZoom);

  refreshStyleThumbnails();
  updateReadouts();
  writeHash();
}

/**
 * Not every basemap can have its labels stripped: CARTO ships label-free
 * variants, Esri's canvases keep labels in a separate overlay, but the likes of
 * OpenTopoMap bake them into the tile. Reflect that honestly in the switch.
 */
function updateLabelSwitch() {
  const layer = getLayer(state.layerId);
  const canToggle = supportsLabelToggle(layer);

  el.labels.disabled = !canToggle;
  el.labelsSwitch.classList.toggle('is-disabled', !canToggle);
  el.labels.checked = canToggle ? state.labels : !layer.labelsNever;

  if (canToggle) {
    el.labelsHint.hidden = true;
  } else {
    el.labelsHint.hidden = false;
    el.labelsHint.textContent = layer.labelsNever
      ? `${layer.label} is shaded terrain only — there are no labels to remove.`
      : `${layer.label} bakes its labels into the tiles, so they cannot be removed.`;
  }
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
    if (!e.target.closest('.search-wrap') && !e.target.closest('.results')) {
      hideResults();
    }
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

  // --- Labels -----------------------------------------------------
  el.labels.addEventListener('change', () => {
    state.labels = el.labels.checked;
    applyTileLayer();
    refreshStyleThumbnails();
    updateReadouts();
    writeHash();
  });

  // --- Orientation ------------------------------------------------
  el.swapOrientation.addEventListener('click', () => {
    const { width, height } = state;
    state.width = height;
    state.height = width;
    syncControlsFromState();
    updateEverything();
    fitFrame();
  });

  // --- Format, quality, caption -----------------------------------
  el.quality.addEventListener('input', () => {
    state.quality = Number(el.quality.value) / 100;
    el.qualityOut.textContent = el.quality.value;
  });

  el.captionToggle.addEventListener('change', () => {
    state.caption = el.captionToggle.checked;
    el.captionText.hidden = !state.caption;
    if (state.caption && !el.captionText.value) {
      el.captionText.value = defaultCaption();
      state.captionText = el.captionText.value;
    }
  });

  el.captionText.addEventListener('input', () => {
    state.captionText = el.captionText.value;
  });

  el.attributionToggle.addEventListener('change', () => {
    state.attribution = el.attributionToggle.checked;
  });

  el.pickLocation.disabled = !CAN_PICK_LOCATION;
  el.pickLocationSwitch.classList.toggle('is-disabled', !CAN_PICK_LOCATION);
  el.saveHint.textContent = CAN_PICK_LOCATION
    ? 'A save dialog opens before the render starts.'
    : 'This browser has no save dialog for web pages — files go to your ' +
      'downloads folder.';

  el.pickLocation.addEventListener('change', () => {
    state.pickLocation = el.pickLocation.checked;
  });

  // --- Buttons ----------------------------------------------------
  el.fitFrame.addEventListener('click', fitFrame);
  el.surprise.addEventListener('click', surpriseMe);
  el.generate.addEventListener('click', generate);

  // Leaflet tracks the resize itself; we only need to re-measure the frame, and
  // pull the view back if the new size left the frame larger than the map.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    updateFrame();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (el.frame.classList.contains('oversized')) fitFrame();
    }, 250);
  });
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
  const gsdText = formatResolution(plan.outputMetersPerPixel);

  el.coverageOut.textContent = formatDistance(state.coverageKm);
  el.detailHint.textContent =
    `${gsdText} in the export · source zoom ${plan.zoom} · ` +
    `${plan.tileCount} tiles` +
    (plan.passes > 1 ? ` (${plan.tilesPerPass} + labels)` : '');

  el.placeName.textContent = state.placeName || 'Custom location';
  el.placeMeta.textContent =
    `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)} · ` +
    `${formatDistance(state.coverageKm)} wide · ${getLayer(state.layerId).label}`;

  if (plan.clamped) {
    el.detailHint.textContent +=
      ` · ${getLayer(state.layerId).label} has no detail past zoom ${plan.layer.maxZoom}`;
  } else if (plan.tileCount > 600) {
    // Not slow enough to warn about — a few hundred tiles is seconds — but it
    // is a lot to ask of a free tile server, which is worth knowing first.
    el.detailHint.textContent += ' · a heavy ask of a free tile server';
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

  const format = FORMATS.find((f) => f.id === state.format) || FORMATS[0];
  const filename = buildFilename(format);

  // Ask where to save *first*: showSaveFilePicker needs the click's transient
  // activation, which a minute of tile fetching would have long since spent.
  let fileHandle = null;
  if (state.pickLocation && CAN_PICK_LOCATION) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: `${format.label} image`,
            accept: { [format.mime]: [`.${format.ext}`] }
          }
        ]
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus('Save cancelled — nothing was rendered.');
        return;
      }
      throw err;
    }
  }

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
      labels: state.labels,
      width: state.width,
      height: state.height,
      coverageKm: state.coverageKm,
      filter: state.filter,
      attribution: state.attribution,
      styleColors: activeStyleColors(),
      caption: state.caption ? state.captionText || defaultCaption() : null,
      onProgress: ({ loaded, total, phase }) => {
        if (phase === 'compose') {
          setProgress(1, 'Composing and downscaling…');
        } else {
          setProgress(total ? loaded / total : 0, `Loading tile ${loaded} / ${total}`);
        }
      }
    });

    setProgress(1, `Encoding ${format.label}…`);
    const blob = await canvasToBlob(
      canvas,
      format.mime,
      format.lossy ? state.quality : undefined
    );

    let where = 'Downloaded';
    if (fileHandle) {
      setProgress(1, 'Writing file…');
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      where = `Saved to ${fileHandle.name}`;
    } else {
      downloadBlob(blob, filename);
    }

    const size = (blob.size / 1024 / 1024).toFixed(1);
    const note = failedTiles
      ? ` ${failedTiles} tile${failedTiles === 1 ? '' : 's'} could not be loaded and were left blank.`
      : '';
    setStatus(
      `${where}: ${state.width} × ${state.height} from ${plan.tileCount} tiles ` +
        `at zoom ${plan.zoom} (${size} MB).${note}`,
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

function buildFilename(format) {
  const base = slugify(shortPlaceName() || 'map');
  return `${base || 'map'}-${state.width}x${state.height}.${format.ext}`;
}

/** "Kyoto · 35.0116, 135.7681" — the default burned-in caption. */
function defaultCaption() {
  const coords = `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
  const name = shortPlaceName();
  return name ? `${name} · ${coords}` : coords;
}

/** Just the leading part of the place name, ignoring the shared-link filler. */
function shortPlaceName() {
  const raw =
    state.placeName && state.placeName !== SHARED_VIEW_NAME
      ? state.placeName
      : el.search.value;
  return (raw || '').split(',')[0].trim();
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
    `${state.width}x${state.height},${state.coverageKm.toFixed(2)},` +
    `${state.labels ? 'labels' : 'nolabels'},` +
    `${serialiseStyleColors()}`;
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

  const [lat, lon, zoom, style, resolution, coverage, labels, colours] =
    raw.split(',');
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

  if (labels) state.labels = labels === 'labels';
  if (colours) deserialiseStyleColors(colours);

  state.placeName = SHARED_VIEW_NAME;
  return true;
}

/** Returns 'hash', 'storage', or null depending on where the view came from. */
function restoreState() {
  const fromHash = readHash();
  const saved = readSaved();

  if (fromHash) {
    // Reloading your own tab is far more common than opening someone else's
    // link: if the saved place sits at these coordinates, keep its name.
    if (
      saved &&
      Math.abs(saved.lat - state.lat) < 0.002 &&
      Math.abs(saved.lon - state.lon) < 0.002
    ) {
      state.placeName = saved.placeName || state.placeName;
      if (saved.query) el.search.value = saved.query;
    }
    return 'hash';
  }

  if (saved) {
    state.lat = saved.lat;
    state.lon = saved.lon;
    state.placeName = saved.placeName || state.placeName;
    if (saved.query) el.search.value = saved.query;
    return 'storage';
  }
  return null;
}

/** The active style's colours as bare hex joined by dashes, or "-" if none. */
function serialiseStyleColors() {
  const layer = getLayer(state.layerId);
  if (!layer.pixelStyle) return '-';
  const colors = activeStyleColors();
  return PIXEL_STYLES[layer.pixelStyle].colors
    .map((slot) => (colors[slot.key] || '').replace('#', ''))
    .join('-');
}

function deserialiseStyleColors(encoded) {
  const layer = getLayer(state.layerId);
  if (!layer.pixelStyle || encoded === '-') return;

  const parts = encoded.split('-');
  const slots = PIXEL_STYLES[layer.pixelStyle].colors;
  const picked = {};
  slots.forEach((slot, i) => {
    if (parts[i] && /^[0-9a-f]{6}$/i.test(parts[i])) {
      picked[slot.key] = `#${parts[i].toLowerCase()}`;
    }
  });
  if (Object.keys(picked).length) state.styleColors[state.layerId] = picked;
}

function readSaved() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ||
      localStorage.getItem(LEGACY_STORAGE_KEY);
    const saved = JSON.parse(raw || 'null');
    if (saved && isFinite(saved.lat) && isFinite(saved.lon)) {
      // Move it under the current key and retire the old one.
      if (!localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, raw);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
      return saved;
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
  el.quality.value = Math.round(state.quality * 100);
  el.qualityOut.textContent = el.quality.value;
  el.captionToggle.checked = state.caption;
  el.captionText.hidden = !state.caption;
  el.attributionToggle.checked = state.attribution;
  el.pickLocation.checked = state.pickLocation && CAN_PICK_LOCATION;

  [...el.styles.querySelectorAll('.style-btn')].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.layer === state.layerId))
  );
  [...el.filters.children].forEach((c) =>
    c.setAttribute('aria-checked', String(c.dataset.filter === state.filter))
  );

  updateLabelSwitch();
  buildStyleColorRows();
}

/** A coverage width in the user's units, e.g. "8.0 km" or "3,107 mi". */
function formatDistance(km) {
  const { value, suffix } = UNITS[state.units].distance(km);
  const text =
    value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString();
  return `${text} ${suffix}`;
}

/** Ground sample distance, in whichever unit keeps the number readable. */
function formatResolution(metersPerPixel) {
  const { value, digits, suffix } = UNITS[state.units].resolution(metersPerPixel);
  // Past three figures the decimal is noise — "1179 ft/px", not "1178.8".
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${suffix}`;
}

function buildUnitToggle() {
  el.units.innerHTML = '';
  Object.values(UNITS).forEach((unit) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.dataset.unit = unit.id;
    btn.textContent = unit.label;
    btn.addEventListener('click', () => setUnits(unit.id));
    el.units.appendChild(btn);
  });
  markUnits();
}

function setUnits(id) {
  state.units = UNITS[id] ? id : 'km';
  markUnits();
  updateReadouts();
  try {
    localStorage.setItem(UNITS_KEY, state.units);
  } catch (err) {
    /* private mode — the choice just will not persist */
  }
}

function markUnits() {
  [...el.units.children].forEach((btn) =>
    btn.setAttribute('aria-checked', String(btn.dataset.unit === state.units))
  );
}

/**
 * Default to whatever the browser's locale implies, so an American lands on
 * miles without hunting for the switch. Explicit choices are remembered.
 */
function preferredUnits() {
  try {
    const saved = localStorage.getItem(UNITS_KEY);
    if (saved && UNITS[saved]) return saved;
  } catch (err) {
    /* unavailable storage — fall through to the locale guess */
  }
  const locale = (navigator.language || 'en').toLowerCase();
  return /^en-(us|lr)|^my\b/.test(locale) ? 'mi' : 'km';
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
state.units = preferredUnits();
buildUnitToggle();
buildStyleButtons();
buildFilterChips();
buildFormatChips();
initMap();
bindControls();
syncControlsFromState();
updateEverything();
refreshStyleThumbnails();
// A shared link carries its own zoom; anything else should open already framed.
if (restoredFrom !== 'hash') fitFrame();
