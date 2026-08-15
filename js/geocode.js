/**
 * geocode.js — thin, well-behaved Nominatim client.
 *
 * Nominatim's usage policy allows at most one request per second and asks that
 * clients cache results rather than re-querying. Both are enforced here: every
 * request goes through a serialised queue with a >=1s gap, and identical
 * queries are answered from an in-memory cache without touching the network.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100; // a little headroom over the 1 req/sec limit
const MAX_RESULTS = 5;

/** query (normalised) -> array of results */
const cache = new Map();

let lastRequestAt = 0;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalise(query) {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Search for a place. Returns at most 5 results shaped as
 * `{ name, lat, lon, type }`. Rejects with an AbortError if `signal` fires.
 */
export function geocode(query, signal) {
  const key = normalise(query);
  if (!key) return Promise.resolve([]);
  if (cache.has(key)) return Promise.resolve(cache.get(key));

  // Chain onto the queue so concurrent callers still respect 1 req/sec.
  const run = queue.then(async () => {
    if (signal && signal.aborted) throw abortError();
    if (cache.has(key)) return cache.get(key);

    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    if (signal && signal.aborted) throw abortError();

    lastRequestAt = Date.now();

    const url =
      `${ENDPOINT}?q=${encodeURIComponent(key)}` +
      `&format=json&limit=${MAX_RESULTS}&addressdetails=0`;

    const res = await fetch(url, {
      signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);

    const raw = await res.json();
    const results = raw.slice(0, MAX_RESULTS).map((r) => ({
      name: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: [r.type, r.class].filter(Boolean)[0] || ''
    }));

    cache.set(key, results);
    return results;
  });

  // Keep the queue alive even when a link in the chain fails or is aborted.
  queue = run.catch(() => {});
  return run;
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/** Trailing-edge debounce. */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/**
 * Shorten a Nominatim display_name for the primary line of a result row:
 * "Paris, Île-de-France, France" -> "Paris" plus the rest as context.
 */
export function splitDisplayName(displayName) {
  const parts = displayName.split(',').map((p) => p.trim());
  return { primary: parts[0], secondary: parts.slice(1).join(', ') };
}
