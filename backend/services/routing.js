/**
 * Routing service — wraps OSRM road-distance API with:
 *  - SQLite cache (route_cache table, 6-hour TTL)
 *  - Configurable provider via OSRM_BASE_URL env var (default: http://router.project-osrm.org)
 *  - Safe fallback to haversine when OSRM is unavailable
 *  - Request throttling (min 1100ms between OSRM calls via simple queue)
 *  - Configurable daily request quota via OSRM_DAILY_QUOTA env var (default 500)
 *  - getRouteWithGeometry() for frontend polyline display
 *  - Never throws; always returns { distanceKm, durationMinutes, provider, cached, error? }
 *
 * Environment variables:
 *   OSRM_BASE_URL       — base URL for OSRM HTTP API (default: http://router.project-osrm.org)
 *   OSRM_DAILY_QUOTA    — max fresh OSRM requests per calendar day (default: 500)
 *   NOMINATIM_BASE_URL  — base URL for Nominatim geocoding (default: https://nominatim.openstreetmap.org)
 */

const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');

const DEFAULT_OSRM_BASE_URL = 'http://router.project-osrm.org';
const CACHE_TTL_HOURS = 6;
const THROTTLE_MS = 1100;
const OSRM_TIMEOUT_MS = 5000;
const DEFAULT_DAILY_QUOTA = 500;

// ── Rate limiting ──────────────────────────────────────────────────────────────
let lastCallMs = 0;
// Daily quota tracking (resets at midnight by checking the date string)
let quotaDate = '';
let quotaUsedToday = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastCallMs;
  if (elapsed < THROTTLE_MS) {
    await sleep(THROTTLE_MS - elapsed);
  }
  lastCallMs = Date.now();
}

function checkQuota() {
  const today = new Date().toISOString().slice(0, 10);
  if (quotaDate !== today) {
    quotaDate = today;
    quotaUsedToday = 0;
  }
  const limit = parseInt(process.env.OSRM_DAILY_QUOTA || String(DEFAULT_DAILY_QUOTA), 10);
  if (quotaUsedToday >= limit) {
    return { allowed: false, reason: `Daily OSRM quota (${limit}) reached; using haversine fallback` };
  }
  quotaUsedToday++;
  return { allowed: true };
}

// ── Haversine fallback ─────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function haversineFallback(lat1, lng1, lat2, lng2, errorMsg) {
  const distanceKm = haversineKm(lat1, lng1, lat2, lng2) || 0;
  // Urban model: 40 min pickup prep + road travel at avg 25 km/h
  const durationMinutes = (distanceKm / 25) * 60 + 40;
  return {
    distanceKm,
    durationMinutes,
    provider: 'haversine (approx — OSRM unavailable)',
    cached: false,
    error: errorMsg || 'OSRM unavailable'
  };
}

// ── HTTP request with timeout ──────────────────────────────────────────────────
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'FoodBridge/1.0 (food-waste-reduction)' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('OSRM request timed out after ' + timeoutMs + 'ms'));
    });
  });
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
function makeCacheKey(oLat, oLng, dLat, dLng) {
  return `${oLat.toFixed(4)},${oLng.toFixed(4)}->${dLat.toFixed(4)},${dLng.toFixed(4)}`;
}

function readCache(key) {
  try {
    return db.prepare(
      `SELECT * FROM route_cache WHERE cache_key = ? AND cached_at >= datetime('now', ?) LIMIT 1`
    ).get(key, `-${CACHE_TTL_HOURS} hours`) || null;
  } catch { return null; }
}

function writeCache(key, oLat, oLng, dLat, dLng, distanceKm, durationMinutes, provider, resultJson) {
  try {
    db.prepare(`
      INSERT INTO route_cache (id, cache_key, origin_lat, origin_lng, dest_lat, dest_lng,
        distance_km, duration_minutes, provider, result_json, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET
        distance_km = excluded.distance_km,
        duration_minutes = excluded.duration_minutes,
        provider = excluded.provider,
        result_json = excluded.result_json,
        cached_at = excluded.cached_at
    `).run(uuidv4(), key, oLat, oLng, dLat, dLng, distanceKm, durationMinutes, provider,
           resultJson || null);
  } catch (err) {
    console.warn('[Routing] Cache write error:', err.message);
  }
}

// ── getRoute — distance + duration only (used by matching engine) ─────────────
async function getRoute(originLat, originLng, destLat, destLng) {
  const cacheKey = makeCacheKey(originLat, originLng, destLat, destLng);
  const cached = readCache(cacheKey);
  if (cached) {
    return { distanceKm: cached.distance_km, durationMinutes: cached.duration_minutes, provider: 'cached', cached: true };
  }

  const quota = checkQuota();
  if (!quota.allowed) {
    console.warn('[Routing]', quota.reason);
    return haversineFallback(originLat, originLng, destLat, destLng, quota.reason);
  }

  await throttle();
  const osrmBase = (process.env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL).replace(/\/$/, '');
  const url = `${osrmBase}/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=false`;

  try {
    const json = await httpGet(url, OSRM_TIMEOUT_MS);
    if (!json.routes || !json.routes[0]) throw new Error('No routes returned by OSRM');
    const route = json.routes[0];
    const distanceKm = route.distance / 1000;
    const durationMinutes = route.duration / 60;
    writeCache(cacheKey, originLat, originLng, destLat, destLng, distanceKm, durationMinutes, 'osrm', null);
    return { distanceKm, durationMinutes, provider: 'osrm', cached: false };
  } catch (err) {
    console.warn('[Routing] OSRM unavailable, falling back to haversine:', err.message);
    return haversineFallback(originLat, originLng, destLat, destLng, err.message);
  }
}

// ── getRouteWithGeometry — full polyline for map display ──────────────────────
// Returns { distanceKm, durationMinutes, provider, cached, geometry: [[lat,lng],...] }
async function getRouteWithGeometry(originLat, originLng, destLat, destLng) {
  const geoCacheKey = `geom:${makeCacheKey(originLat, originLng, destLat, destLng)}`;
  const cached = readCache(geoCacheKey);
  if (cached && cached.result_json) {
    try {
      const parsed = JSON.parse(cached.result_json);
      return { ...parsed, provider: 'cached', cached: true };
    } catch { /* fall through */ }
  }

  const quota = checkQuota();
  if (!quota.allowed) {
    // Return straight-line two-point geometry as fallback
    return {
      distanceKm: haversineKm(originLat, originLng, destLat, destLng) || 0,
      durationMinutes: ((haversineKm(originLat, originLng, destLat, destLng) || 0) / 25) * 60 + 40,
      provider: 'haversine (approx)',
      cached: false,
      geometry: [[originLat, originLng], [destLat, destLng]],
      error: quota.reason
    };
  }

  await throttle();
  const osrmBase = (process.env.OSRM_BASE_URL || DEFAULT_OSRM_BASE_URL).replace(/\/$/, '');
  // overview=full returns encoded polyline; geometries=geojson returns GeoJSON LineString
  const url = `${osrmBase}/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;

  try {
    const json = await httpGet(url, OSRM_TIMEOUT_MS);
    if (!json.routes || !json.routes[0]) throw new Error('No routes returned');
    const route = json.routes[0];
    const distanceKm = route.distance / 1000;
    const durationMinutes = route.duration / 60;
    // GeoJSON coords are [lng, lat]; Leaflet wants [lat, lng]
    const geometry = (route.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng]);

    const result = { distanceKm, durationMinutes, provider: 'osrm', cached: false, geometry };
    writeCache(geoCacheKey, originLat, originLng, destLat, destLng, distanceKm, durationMinutes, 'osrm', JSON.stringify(result));
    return result;
  } catch (err) {
    console.warn('[Routing] Geometry request failed, using straight line:', err.message);
    const distanceKm = haversineKm(originLat, originLng, destLat, destLng) || 0;
    const durationMinutes = (distanceKm / 25) * 60 + 40;
    return {
      distanceKm,
      durationMinutes,
      provider: 'haversine (approx — OSRM unavailable)',
      cached: false,
      geometry: [[originLat, originLng], [destLat, destLng]],
      error: err.message
    };
  }
}

module.exports = { getRoute, getRouteWithGeometry, haversineKm };
