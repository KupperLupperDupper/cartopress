/**
 * tiles.js — tile layer catalogue + Web Mercator maths.
 *
 * Everything here is pure and side-effect free so the export renderer and the
 * Leaflet preview can share exactly the same numbers.
 */

export const TILE_SIZE = 256;

/** Metres per pixel at zoom 0 on the equator (circumference / 256). */
export const EARTH_METERS_PER_PIXEL = 156543.03392;

/**
 * Tile layers. `url` is a Leaflet-style template — note that Esri World
 * Imagery serves {z}/{y}/{x}, which is *not* the usual order. Substitution is
 * done by name so the order in the template is what counts.
 */
export const LAYERS = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #3f5b3a, #6d7f4a 45%, #2e4a63)',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    leafletAttribution:
      'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    maxZoom: 20,
    subdomains: ['a', 'b', 'c', 'd'],
    swatch: 'linear-gradient(135deg, #16181d, #2b3038 60%, #3a4150)',
    attribution: '© OpenStreetMap contributors © CARTO',
    leafletAttribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  light: {
    id: 'light',
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    maxZoom: 20,
    subdomains: ['a', 'b', 'c', 'd'],
    swatch: 'linear-gradient(135deg, #f2f2ef, #d9dcd6 60%, #b9c2c8)',
    attribution: '© OpenStreetMap contributors © CARTO',
    leafletAttribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    subdomains: ['a', 'b', 'c'],
    swatch: 'linear-gradient(135deg, #dcd6c2, #b9c49a 55%, #8fa8b8)',
    attribution: '© OpenStreetMap contributors, SRTM — style: OpenTopoMap (CC-BY-SA)',
    leafletAttribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  }
};

export const LAYER_LIST = Object.values(LAYERS);

export function getLayer(id) {
  return LAYERS[id] || LAYERS.satellite;
}

/**
 * Fill a tile URL template. Subdomains are picked deterministically from the
 * tile coordinates so repeated renders hit the same hosts (and the same cache).
 */
export function buildTileUrl(layer, x, y, z, retina = '') {
  let url = layer.url
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', retina);

  if (url.includes('{s}')) {
    const subs = layer.subdomains || ['a', 'b', 'c'];
    url = url.replace('{s}', subs[Math.abs(x + y) % subs.length]);
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* Web Mercator                                                        */
/* ------------------------------------------------------------------ */

export function worldSize(z) {
  return TILE_SIZE * Math.pow(2, z);
}

/** Longitude -> absolute pixel X at zoom z. */
export function lonToPixelX(lon, z) {
  return ((lon + 180) / 360) * worldSize(z);
}

/** Latitude -> absolute pixel Y at zoom z. */
export function latToPixelY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    worldSize(z)
  );
}

/** Absolute pixel X at zoom z -> longitude. */
export function pixelXToLon(px, z) {
  return (px / worldSize(z)) * 360 - 180;
}

/** Absolute pixel Y at zoom z -> latitude. */
export function pixelYToLat(py, z) {
  const n = Math.PI - (2 * Math.PI * py) / worldSize(z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ground resolution in metres per pixel at a latitude and zoom. */
export function metersPerPixel(lat, z) {
  return (
    (EARTH_METERS_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z)
  );
}

/**
 * The integer zoom at which `coverageMeters` of ground maps onto at least
 * `targetWidth` pixels. Clamped to the layer's max zoom (below which we would
 * be asking a tile server for something it does not have).
 */
export function zoomForCoverage(lat, targetWidth, coverageMeters, maxZoom) {
  const raw = Math.log2(
    (EARTH_METERS_PER_PIXEL * Math.cos((lat * Math.PI) / 180) * targetWidth) /
      coverageMeters
  );
  return Math.max(0, Math.min(maxZoom, Math.ceil(raw)));
}
