/**
 * tiles.js — tile layer catalogue + Web Mercator maths.
 *
 * Everything here is pure and side-effect free so the export renderer and the
 * Leaflet preview can share exactly the same numbers.
 */

export const TILE_SIZE = 256;

/** Metres per pixel at zoom 0 on the equator (circumference / 256). */
export const EARTH_METERS_PER_PIXEL = 156543.03392;

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

const ESRI_IMAGERY_CREDIT = 'Imagery © Esri, Maxar, Earthstar Geographics';
const ESRI_MAP_CREDIT = 'Map © Esri — sources: HERE, Garmin, USGS, OSM contributors';
const ESRI_LEAFLET = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>';

/**
 * Tile layers.
 *
 * `url` is a Leaflet-style template — note that every Esri endpoint serves
 * {z}/{y}/{x}, which is *not* the usual order, so substitution is done by name
 * rather than by position.
 *
 * Labels are handled one of two ways, which is what the "Road names & labels"
 * switch drives:
 *   - `labelsOverlay` transparent label tiles drawn on top of a bare basemap
 *   - `labelsFixed`  the basemap has labels baked in and cannot be stripped
 */
export const LAYERS = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    group: 'Imagery',
    url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    labelsOverlay: [
      `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
      `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`
    ],
    maxZoom: 19,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #3f5b3a, #6d7f4a 45%, #2e4a63)',
    attribution: ESRI_IMAGERY_CREDIT,
    leafletAttribution:
      'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
  },

  neon: {
    id: 'neon',
    label: 'Neon',
    group: 'Cartographic',
    // Esri's dark grey canvas with its road network remapped through a neon ramp.
    // `pixelStyle` is applied by render.js to the export and by the preview's
    // canvas tile layer, so both go through exactly the same code.
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labelsOverlay: [
      `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`
    ],
    pixelStyle: 'neon',
    maxZoom: 16,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #04010c, #072a63 45%, #1ce7ff)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  linework: {
    id: 'linework',
    label: 'Line drawing',
    group: 'Drawn',
    // Same dark canvas, mapped to ink on paper instead of glow on black.
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labelsOverlay: [
      `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`
    ],
    pixelStyle: 'ink',
    maxZoom: 16,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #f3ecdf, #e4dac6 60%, #cbc0a8)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    group: 'Drawn',
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labelsOverlay: [
      `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`
    ],
    pixelStyle: 'ink',
    pixelColors: { ink: '#dbe9ff', paper: '#0d2b4f' },
    maxZoom: 16,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #0d2b4f, #14406f 60%, #dbe9ff)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  graphite: {
    id: 'graphite',
    label: 'Graphite',
    group: 'Cartographic',
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labelsOverlay: [
      `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`
    ],
    maxZoom: 16,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #2b2b2b, #3d3d3d 60%, #565656)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  paper: {
    id: 'paper',
    label: 'Paper',
    group: 'Cartographic',
    url: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labelsOverlay: [
      `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`
    ],
    maxZoom: 16,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #f4f2ee, #e2ded6 60%, #cbc7bf)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  streets: {
    id: 'streets',
    label: 'Streets',
    group: 'Cartographic',
    url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
    labelsFixed: true,
    maxZoom: 19,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #f7f2e8, #e8dfcc 55%, #c9d6c0)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  topographic: {
    id: 'topographic',
    label: 'Topographic',
    group: 'Terrain',
    url: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
    labelsFixed: true,
    maxZoom: 19,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #eae5d6, #cfd8bd 55%, #a8bfa0)',
    attribution: ESRI_MAP_CREDIT,
    leafletAttribution: ESRI_LEAFLET
  },

  terrain: {
    id: 'terrain',
    label: 'Terrain',
    group: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    labelsFixed: true,
    maxZoom: 17,
    subdomains: ['a', 'b', 'c'],
    swatch: 'linear-gradient(135deg, #dcd6c2, #b9c49a 55%, #8fa8b8)',
    attribution: '© OpenStreetMap contributors, SRTM — style: OpenTopoMap (CC-BY-SA)',
    leafletAttribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  },

  relief: {
    id: 'relief',
    label: 'Relief',
    group: 'Terrain',
    url: `${ESRI}/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`,
    // Pure shaded relief: there is nothing to label, so the switch stays off.
    labelsNever: true,
    maxZoom: 16,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #d9d4cc, #b3ada4 55%, #85807a)',
    attribution: 'Hillshade © Esri — sources: USGS, NASA, NGA',
    leafletAttribution: ESRI_LEAFLET
  },

  natgeo: {
    id: 'natgeo',
    label: 'National Geographic',
    group: 'Cartographic',
    url: `${ESRI}/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}`,
    labelsFixed: true,
    // The service lists 16 levels, but outside the US everything past 12 is a
    // grey "Map data not yet available" tile.
    maxZoom: 12,
    subdomains: null,
    swatch: 'linear-gradient(135deg, #efe6cf, #d9c9a3 55%, #a8b9a0)',
    attribution: 'Map © Esri, National Geographic — sources: USGS, NOAA',
    leafletAttribution: ESRI_LEAFLET
  }
};

export const LAYER_LIST = Object.values(LAYERS);

/** Layers in display order, bucketed by their group. */
export const LAYER_GROUPS = LAYER_LIST.reduce((groups, layer) => {
  (groups[layer.group] = groups[layer.group] || []).push(layer);
  return groups;
}, {});

export function getLayer(id) {
  return LAYERS[id] || LAYERS.satellite;
}

/** Can this layer's labels be turned off (or on) at all? */
export function supportsLabelToggle(layer) {
  return Boolean(layer.labelsOverlay);
}

/**
 * Resolve a layer id plus the label switch into the concrete URLs to draw:
 * a base template, and zero or more transparent overlay templates on top.
 */
export function resolveLayer(id, showLabels) {
  const layer = getLayer(id);
  const overlays =
    showLabels && layer.labelsOverlay ? layer.labelsOverlay.slice() : [];
  return { ...layer, overlays };
}

/**
 * Fill a tile URL template. Subdomains are picked deterministically from the
 * tile coordinates so repeated renders hit the same hosts (and the same cache).
 */
export function buildTileUrl(template, x, y, z, subdomains, retina = '') {
  let url = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', retina);

  if (url.includes('{s}')) {
    const subs = subdomains || ['a', 'b', 'c'];
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
 * `targetWidth` pixels. Clamped to the layer's max zoom (above which we would
 * be asking a tile server for something it does not have).
 */
export function zoomForCoverage(lat, targetWidth, coverageMeters, maxZoom) {
  const raw = Math.log2(
    (EARTH_METERS_PER_PIXEL * Math.cos((lat * Math.PI) / 180) * targetWidth) /
      coverageMeters
  );
  return Math.max(0, Math.min(maxZoom, Math.ceil(raw)));
}
