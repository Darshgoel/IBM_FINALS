/**
 * Routing & Map Feature Tests
 * Same synchronous pattern as test_matching_rules.js.
 * Async tests use a wrapper that resolves within the runner.
 */

const assert = require('assert');
const db = require('./database/db');
const { v4: uuidv4 } = require('uuid');
const { haversineKm, getRoute } = require('./services/routing');
const {
  checkCompatibility,
  routeToBiogasFacility
} = require('./services/matching');

console.log('═══════════════════════════════════════════════════════════════');
console.log('🧪 Routing & Map Feature Test Suite');
console.log('═══════════════════════════════════════════════════════════════\n');

let passedTests = 0;
let totalTests = 0;
const asyncTests = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error('   ', err.message || err);
  }
}

function asyncTest(name, fn) {
  asyncTests.push({ name, fn });
}

// ── TEST 1: haversineKm correctness ──────────────────────────────────────────
test('haversineKm — known distance between Bengaluru and Mysuru (~140 km)', () => {
  // Bengaluru: 12.9716, 77.5946  |  Mysuru: 12.3052, 76.6552
  const dist = haversineKm(12.9716, 77.5946, 12.3052, 76.6552);
  // Real road ~145 km, straight line ~120-145 km
  assert.ok(dist > 110 && dist < 160,
    `Expected ~120-145 km, got ${dist.toFixed(2)} km`);
});

// ── TEST 2: biogas_facilities schema ─────────────────────────────────────────
test('biogas_facilities — insert and read row', () => {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO biogas_facilities (id, name, location_address, location_lat, location_lng,
      accepted_waste_types, max_daily_intake_kg, status, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1)
  `).run(id, 'Test Biogas Plant', '123 Test Road, Bengaluru', 12.9800, 77.5900,
    JSON.stringify(['cooked_meals', 'dairy']), 200);

  const row = db.prepare('SELECT * FROM biogas_facilities WHERE id = ?').get(id);
  assert.ok(row, 'Row not found');
  assert.strictEqual(row.name, 'Test Biogas Plant');
  assert.strictEqual(row.verified, 1);
  assert.strictEqual(row.status, 'active');
  const types = JSON.parse(row.accepted_waste_types);
  assert.ok(types.includes('cooked_meals'), 'accepted_waste_types should include cooked_meals');

  // Cleanup
  db.prepare('DELETE FROM biogas_facilities WHERE id = ?').run(id);
});

// ── TEST 3: route_cache insert, read, and TTL check ──────────────────────────
test('route_cache — insert, read back, and verify TTL expiry logic', () => {
  const key = `test:${uuidv4()}`;
  const id = uuidv4();

  // Insert fresh cache entry
  db.prepare(`
    INSERT INTO route_cache (id, cache_key, origin_lat, origin_lng, dest_lat, dest_lng,
      distance_km, duration_minutes, provider, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'osrm', datetime('now'))
  `).run(id, key, 12.97, 77.59, 13.01, 77.57, 5.2, 18.4);

  const fresh = db.prepare(
    `SELECT * FROM route_cache WHERE cache_key = ? AND cached_at >= datetime('now', '-6 hours')`
  ).get(key);
  assert.ok(fresh, 'Fresh cache entry should be found');
  assert.strictEqual(fresh.provider, 'osrm');
  assert.ok(Math.abs(fresh.distance_km - 5.2) < 0.01, 'distance_km mismatch');

  // Insert stale entry (older than 6 hours)
  const staleKey = `stale:${uuidv4()}`;
  const staleId = uuidv4();
  db.prepare(`
    INSERT INTO route_cache (id, cache_key, origin_lat, origin_lng, dest_lat, dest_lng,
      distance_km, duration_minutes, provider, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'osrm', datetime('now', '-7 hours'))
  `).run(staleId, staleKey, 12.97, 77.59, 13.01, 77.57, 5.2, 18.4);

  const stale = db.prepare(
    `SELECT * FROM route_cache WHERE cache_key = ? AND cached_at >= datetime('now', '-6 hours')`
  ).get(staleKey);
  assert.strictEqual(stale, undefined, 'Stale cache entry should NOT be found by TTL query');

  // Cleanup
  db.prepare('DELETE FROM route_cache WHERE id IN (?, ?)').run(id, staleId);
});

// ── TEST 4: getRoute falls back to haversine on unreachable host ──────────────
asyncTest('getRoute — non-existent OSRM host falls back to haversine', async () => {
  // Use unique random coords that are guaranteed not to be in the cache
  const oLat = 11.0 + Math.random() * 0.01;
  const oLng = 76.0 + Math.random() * 0.01;
  const dLat = 10.0 + Math.random() * 0.01;
  const dLng = 75.0 + Math.random() * 0.01;

  // Override env to non-existent port BEFORE calling getRoute (env is read per call now)
  const origUrl = process.env.OSRM_BASE_URL;
  process.env.OSRM_BASE_URL = 'http://127.0.0.1:19999'; // nothing listening here

  const result = await getRoute(oLat, oLng, dLat, dLng);

  // Restore env
  if (origUrl === undefined) delete process.env.OSRM_BASE_URL;
  else process.env.OSRM_BASE_URL = origUrl;

  assert.ok(result.provider.startsWith('haversine'), `Expected haversine fallback, got ${result.provider}`);
  assert.ok(result.error, 'Expected error message to be set');
  assert.ok(typeof result.distanceKm === 'number' && result.distanceKm > 0, 'distanceKm should be a positive number');
  assert.ok(typeof result.durationMinutes === 'number' && result.durationMinutes > 0, 'durationMinutes should be positive');
});

// ── TEST 5: routeToBiogasFacility creates a biogas_routes row with facility_id ─
test('routeToBiogasFacility — creates biogas_routes row with biogas_facility_id', () => {
  // Snapshot active facility IDs before test, then deactivate them so our
  // test facility is the only candidate (no verified gate needed any more).
  const wasActive = db.prepare("SELECT id FROM biogas_facilities WHERE status = 'active'").all().map(r => r.id);
  if (wasActive.length) {
    db.prepare(`UPDATE biogas_facilities SET status = 'inactive' WHERE id IN (${wasActive.map(() => '?').join(',')})`)
      .run(...wasActive);
  }

  // Create a test biogas facility — status='active', no verified column needed
  const facilityId = uuidv4();
  db.prepare(`
    INSERT INTO biogas_facilities (id, name, location_address, location_lat, location_lng,
      accepted_waste_types, max_daily_intake_kg, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(facilityId, 'Route Test Facility', 'Test Area, Bengaluru', 12.9716, 77.5946,
    JSON.stringify(['cooked_meals', 'all_food_waste']), 500);

  // Create a test donor org
  const donorOrgId = uuidv4();
  db.prepare(`
    INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, status, verified)
    VALUES (?, ?, 'hotel', 'Test Hotel Road', 12.9716, 77.5946, 'active', 1)
  `).run(donorOrgId, 'Test Hotel Routing');

  const surplusId = uuidv4();
  const fakeSurplus = {
    id: surplusId,
    donor_org_id: donorOrgId,
    food_name: 'Test Paneer Masala',
    food_type: 'cooked_meals',
    quantity: 30,
    remaining_quantity: 30,
    quantity_unit: 'servings'
  };

  routeToBiogasFacility(fakeSurplus, 'Test reason for routing', 30);

  const routeRow = db.prepare('SELECT * FROM biogas_routes WHERE surplus_id = ?').get(surplusId);
  assert.ok(routeRow, 'biogas_routes row should exist');
  assert.strictEqual(routeRow.biogas_facility_id, facilityId,
    `Expected facility_id ${facilityId}, got ${routeRow.biogas_facility_id}`);
  assert.strictEqual(routeRow.destination_name, 'Route Test Facility');
  assert.strictEqual(routeRow.food_type, 'cooked_meals');

  // Cleanup — restore exactly the facilities that were active before
  db.prepare('DELETE FROM biogas_routes WHERE surplus_id = ?').run(surplusId);
  db.prepare('DELETE FROM biogas_facilities WHERE id = ?').run(facilityId);
  db.prepare('DELETE FROM organizations WHERE id = ?').run(donorOrgId);
  if (wasActive.length) {
    db.prepare(`UPDATE biogas_facilities SET status = 'active' WHERE id IN (${wasActive.map(() => '?').join(',')})`)
      .run(...wasActive);
  }
});

// ── TEST 6: checkCompatibility uses OSRM distance when routeResult provided ──
test('checkCompatibility — uses routeResult.distanceKm when provided', () => {
  const surplus = {
    food_name: 'Veg Biryani',
    food_type: 'cooked_meals',
    quantity: 40,
    remaining_quantity: 40,
    quantity_unit: 'servings',
    dietary_tags: '["veg"]',
    remaining_usable_time: new Date(Date.now() + 5 * 3600000).toISOString()
  };
  const demand = {
    food_requirement: 'Cooked Meals',
    quantity_needed: 30,
    remaining_quantity: 30,
    quantity_unit: 'servings',
    dietary_requirements: '["veg"]',
    required_by: new Date(Date.now() + 4 * 3600000).toISOString(),
    urgency: 'regular',
    status: 'open'
  };
  const donorOrg = { id: 'donor1', location_lat: 12.97, location_lng: 77.59 };
  const demandOrg = { id: 'dem1', location_lat: 12.98, location_lng: 77.60, verified: 1 };
  const demandProfile = {
    food_requirements: '["cooked_meals"]',
    dietary_restrictions: '[]',
    storage_capacity: 'Cold storage available',
    receiving_capacity: '',
    serving_capacity: 500
  };

  // Provide a routeResult with road distance
  const routeResult = { distanceKm: 3.5, durationMinutes: 22, provider: 'osrm' };
  const gate = checkCompatibility(surplus, demand, donorOrg, demandOrg, demandProfile, routeResult);

  assert.ok(gate.pass, `Expected gate to pass, reason: ${gate.reason}`);
  assert.strictEqual(gate.distanceKm, 3.5, 'distanceKm should be from routeResult');
  assert.strictEqual(gate.routeProvider, 'osrm', 'routeProvider should be osrm');
});

// ── TEST 7: match explanation includes routing info ──────────────────────────
test('match explanation — includes routing info when routeResult is provided', () => {
  const { rankCandidate } = require('./services/matching');

  const gateResult = {
    pass: true,
    distanceKm: 4.2,
    transitMinutes: 27,
    routeProvider: 'osrm',
    estimatedArrival: Date.now() + 27 * 60 * 1000,
    surplusExpiry: Date.now() + 4 * 3600000,
    convertedSurplus: 30,
    potentialAlloc: 30,
    surplusRem: 40,
    demandRem: 30
  };
  const surplus = { food_type: 'cooked_meals', id: 'sp1', donor_org_id: 'do1' };
  const demand = {
    urgency: 'regular',
    required_by: new Date(Date.now() + 3 * 3600000).toISOString(),
    quantity_unit: 'servings',
    demand_org_id: uuidv4()
  };
  const demandOrg = { verified: 1 };

  const ranking = rankCandidate(gateResult, surplus, demand, demandOrg);

  assert.ok(typeof ranking.explanation === 'string', 'explanation should be a string');
  assert.ok(ranking.explanation.includes('4.2 km'), `explanation should mention distance: ${ranking.explanation}`);
  assert.ok(ranking.explanation.includes('osrm'), `explanation should mention osrm: ${ranking.explanation}`);
  assert.strictEqual(ranking.routeProvider, 'osrm', 'routeProvider should be osrm');
  assert.strictEqual(ranking.distanceKm, 4.2, 'distanceKm should be 4.2');
});

// ── Run async tests then report ────────────────────────────────────────────────
async function runAsync() {
  for (const { name, fn } of asyncTests) {
    totalTests++;
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error('   ', err.message || err);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`Results: ${passedTests}/${totalTests} tests passed`);
  if (passedTests === totalTests) {
    console.log('🎉 All routing & map tests passed!');
  } else {
    console.log(`⚠️  ${totalTests - passedTests} test(s) failed.`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(passedTests === totalTests ? 0 : 1);
}

runAsync().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
