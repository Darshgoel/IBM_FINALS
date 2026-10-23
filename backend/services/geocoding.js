/**
 * Geocoding service for admin facility location suggestions only.
 * Uses Nominatim (OpenStreetMap). For suggestions only — results MUST be
 * verified by an admin before being stored as confirmed locations.
 * Complies with Nominatim usage policy:
 *  - Max 1 req/s (enforced via throttle)
 *  - User-Agent header required
 *  - Results cached 24 hours in route_cache (reusing cache_key prefix "geocode:")
 */

const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');

const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const THROTTLE_MS = 1100;
const CACHE_TTL_HOURS = 24;

// ── Rate limiting ─────────────────────────────────────────────────────────────
let lastCallMs = 0;

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

// ── HTTP GET ──────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'FoodBridge/1.0 (food-waste-reduction-platform)',
        'Accept-Language': 'en'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('JSON parse error: ' + e.message));
          }
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Nominatim request timed out'));
    });
  });
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
function makeCacheKey(query) {
  return `geocode:${encodeURIComponent(query)}`;
}

function readGeoCache(key) {
  try {
    const row = db.prepare(
      `SELECT result_json FROM route_cache WHERE cache_key = ? AND cached_at >= datetime('now', ?) LIMIT 1`
    ).get(key, `-${CACHE_TTL_HOURS} hours`);
    if (row && row.result_json) {
      return JSON.parse(row.result_json);
    }
    return null;
  } catch {
    return null;
  }
}

function writeGeoCache(key, results) {
  try {
    db.prepare(`
      INSERT INTO route_cache (id, cache_key, result_json, cached_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET
        result_json = excluded.result_json,
        cached_at = excluded.cached_at
    `).run(uuidv4(), key, JSON.stringify(results));
  } catch (err) {
    console.warn('[Geocoding] Cache write error:', err.message);
  }
}

// ── Main exported function ────────────────────────────────────────────────────
async function suggestLocations(query) {
  if (!query || query.trim().length < 2) return [];

  const key = makeCacheKey(query.trim());
  const cached = readGeoCache(key);
  if (cached) return cached;

  await throttle();

  const url = `${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=0`;

  try {
    const results = await httpsGet(url);
    const suggestions = (Array.isArray(results) ? results : []).slice(0, 5).map(r => ({
      display_name: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      importance: r.importance || 0
    }));
    writeGeoCache(key, suggestions);
    return suggestions;
  } catch (err) {
    console.warn('[Geocoding] Nominatim error:', err.message);
    return [];
  }
}

module.exports = { suggestLocations };
