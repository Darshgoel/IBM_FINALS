/**
 * Test Suite: End-to-End Surplus Lifecycle & Flowchart Routing Verification
 *
 * Validates each branch of the flowchart:
 *   Branch 1: Expired surplus -> biogas
 *   Branch 2: Unsafe surplus (unsafe=1) -> biogas
 *   Branch 3: Insufficient delivery window (< 55 min) -> biogas
 *   Branch 4: Uncertain/missing location + tight window -> manual review
 *   Branch 5: Compatible demand found -> ranked & allocated min(surplus, demand)
 *   Branch 6: Multi-split allocation across demands
 *   Branch 7: No compatible demand -> suitable food bank fallback
 *   Branch 8: Incompatible food bank / no recipient -> review or biogas
 */

const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const db = require('./database/db');
const { runUnifiedMatching, runMatching } = require('./services/matching');

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${desc}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${desc}`);
    console.error(err);
    failed++;
  }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('🧪 Flowchart Routing & Lifecycle Test Suite');
console.log('═══════════════════════════════════════════════════════════════\n');

// Helper to create donor org
function createDonorOrg(lat = 12.9716, lng = 77.5946) {
  const orgId = uuidv4();
  db.prepare(`
    INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, status, verified)
    VALUES (?, 'Test Donor Org', 'donor', 'Test Address', ?, ?, 'active', 1)
  `).run(orgId, lat, lng);
  return orgId;
}

// Helper to create demand org
function createDemandOrg(type = 'ngo', lat = 12.9750, lng = 77.5980, storage = 'ambient, dry') {
  const orgId = uuidv4();
  db.prepare(`
    INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, status, verified)
    VALUES (?, 'Test Recipient Org', ?, 'Test Recipient Address', ?, ?, 'active', 1)
  `).run(orgId, type, lat, lng);
  db.prepare(`
    INSERT INTO demand_org_profiles (org_id, food_requirements, dietary_restrictions, storage_capacity, receiving_capacity)
    VALUES (?, '["cooked_meals", "bakery"]', '[]', ?, '500 kg')
  `).run(orgId, storage);
  return orgId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Flowchart Branch B (Yes) — Expired surplus routes to biogas
// ─────────────────────────────────────────────────────────────────────────────
it('Branch B (Yes): Expired surplus routes immediately to biogas centre', () => {
  const donorId = createDonorOrg();
  const surplusId = uuidv4();
  const pastTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Expired Soup', 'cooked_meals', 50, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, pastTime, pastTime);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'biogas_routed');
  assert.ok(surplus.biogas_reason.includes('expired'));

  const biogasRecord = db.prepare('SELECT * FROM biogas_routes WHERE surplus_id = ?').get(surplusId);
  assert.ok(biogasRecord, 'Biogas route audit record created');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Flowchart Branch B (Yes) — Explicitly unsafe surplus routes to biogas
// ─────────────────────────────────────────────────────────────────────────────
it('Branch B (Yes): Surplus marked unsafe=1 routes immediately to biogas centre', () => {
  const donorId = createDonorOrg();
  const surplusId = uuidv4();
  const futureTime = new Date(Date.now() + 5 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, unsafe, status)
    VALUES (?, ?, 'Spoiled Stew', 'cooked_meals', 30, 'servings', ?, ?, 1, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), futureTime);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'biogas_routed');
  assert.ok(surplus.biogas_reason.includes('unsafe'));

  const biogasRecord = db.prepare('SELECT * FROM biogas_routes WHERE surplus_id = ?').get(surplusId);
  assert.ok(biogasRecord, 'Biogas audit record created');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Flowchart Branch C (No) — Delivery window impossible (< 55m) -> Biogas
// ─────────────────────────────────────────────────────────────────────────────
it('Branch C (No): Tight delivery window (<55 min to expiry) routes to biogas', () => {
  const donorId = createDonorOrg();
  const surplusId = uuidv4();
  const verySoon = new Date(Date.now() + 25 * 60 * 1000).toISOString(); // 25 mins left

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Urgent Rice', 'cooked_meals', 20, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), verySoon);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'biogas_routed');
  assert.ok(surplus.biogas_reason.includes('insufficient time'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Flowchart Branch C (Missing Data) -> Manual Review
// ─────────────────────────────────────────────────────────────────────────────
it('Branch C (Missing data): Missing donor coordinates with short window routes to review', () => {
  const donorId = createDonorOrg(0, 0); // No coordinates
  const surplusId = uuidv4();
  const shortWindow = new Date(Date.now() + 40 * 60 * 1000).toISOString(); // 40 mins

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Unlocated Meals', 'cooked_meals', 40, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), shortWindow);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'review_required');
  assert.ok(surplus.review_reason.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Flowchart Branch D-H: Compatible demand found -> allocate min(surplus, demand)
// ─────────────────────────────────────────────────────────────────────────────
it('Branch D-H: Compatible demand found and allocated min(surplus, demand)', () => {
  const donorId = createDonorOrg();
  const uniqueFood = 'biryani_' + Date.now();
  const recipientId = createDemandOrg('ngo');
  db.prepare(`
    UPDATE demand_org_profiles SET food_requirements = ? WHERE org_id = ?
  `).run(JSON.stringify([uniqueFood]), recipientId);

  const surplusId = uuidv4();
  const demandId = uuidv4();
  const safeFuture = new Date(Date.now() + 8 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, quantity_unit, urgency, required_by, status)
    VALUES (?, ?, ?, 25, 'servings', 'emergency', ?, 'open')
  `).run(demandId, recipientId, uniqueFood, safeFuture);

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Fresh Biryani', ?, 60, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, uniqueFood, new Date().toISOString(), safeFuture);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  const demand = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(demandId);
  const match = db.prepare('SELECT * FROM matches WHERE surplus_id = ? AND demand_id = ?').get(surplusId, demandId);

  assert.strictEqual(demand.status, 'fulfilled');
  assert.strictEqual(demand.remaining_quantity, 0);
  assert.strictEqual(match.allocated_quantity, 25);
  // Remaining surplus = 60 - 25 = 35 (or fell back to food bank if active)
  assert.ok(surplus.remaining_quantity <= 35);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Flowchart Branch FB (No demand matches) -> Suitable food bank fallback
// ─────────────────────────────────────────────────────────────────────────────
it('Branch FB & K: When no demand matches, remaining surplus routes to suitable food bank', () => {
  const donorId = createDonorOrg();
  const foodBankOrgId = createDemandOrg('food_bank', 12.9730, 77.5960, 'refrigerated, cold chain, 2000 kg');
  const surplusId = uuidv4();
  const safeFuture = new Date(Date.now() + 6 * 3600 * 1000).toISOString();

  // Surplus with food type 'bakery' where no direct open demand exists
  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Fresh Baguettes', 'bakery', 30, 'pieces', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), safeFuture);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'matched');
  assert.strictEqual(surplus.remaining_quantity, 0);

  const fbMatch = db.prepare('SELECT * FROM matches WHERE surplus_id = ? AND notes = ?').get(surplusId, 'fallback_food_bank');
  assert.ok(fbMatch, 'Food bank fallback match created');
  assert.strictEqual(fbMatch.allocated_quantity, 30);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Flowchart Branch J (No) -> Food bank cannot store perishables -> Review
// ─────────────────────────────────────────────────────────────────────────────
it('Branch J (No): When food bank cannot receive/store or is out of range, escalates to review', () => {
  const donorId = createDonorOrg(13.7, 77.59); // 80 km away, exceeds MAX_MATCH_DISTANCE_KM
  const surplusId = uuidv4();
  const safeFuture = new Date(Date.now() + 4 * 3600 * 1000).toISOString(); // 4 hours left

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Fresh Dairy Milk', 'dairy', 15, 'liters', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), safeFuture);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  // Flowchart: > 2h left -> review_required
  assert.strictEqual(surplus.status, 'review_required');
  assert.ok(surplus.review_reason.includes('review required') || surplus.review_reason.includes('No compatible'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Food-bank type restriction CANNOT be bypassed
// ─────────────────────────────────────────────────────────────────────────────
it('Food bank type restriction: food bank allowing only produce rejects cooked meals', () => {
  const donorId = createDonorOrg(12.9716, 77.5946);
  // Food bank that only accepts packaged goods and fresh produce
  const fbOrgId = createDemandOrg('food_bank', 12.9730, 77.5960, 'ambient, dry, 1000 kg');
  db.prepare(`
    UPDATE demand_org_profiles SET food_requirements = '["produce", "packaged_goods"]' WHERE org_id = ?
  `).run(fbOrgId);

  // Surplus of cooked meals
  const surplusId = uuidv4();
  const safeFuture = new Date(Date.now() + 4 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Hot Cooked Meals', 'cooked_meals', 20, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), safeFuture);

  runUnifiedMatching({ surplusId });

  // The food bank MUST NOT receive cooked meals
  const fbMatch = db.prepare('SELECT * FROM matches WHERE surplus_id = ? AND demand_org_id = ?').get(surplusId, fbOrgId);
  assert.strictEqual(fbMatch, undefined, 'Food bank restricted to produce/packaged goods must NOT receive cooked meals');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Demand-registration path (Path B) finishes routing leftover surplus
// ─────────────────────────────────────────────────────────────────────────────
it('Path B: Demand registration finishes routing leftover surplus to food bank or review', () => {
  const donorId = createDonorOrg(12.9716, 77.5946);
  // Food bank capable of receiving bakery
  const fbOrgId = createDemandOrg('food_bank', 12.9730, 77.5960, 'ambient, dry, 2000 kg');
  db.prepare(`
    UPDATE demand_org_profiles SET food_requirements = '["bakery"]' WHERE org_id = ?
  `).run(fbOrgId);

  // Recipient NGO with demand for 20 rolls of bakery
  const recipientId = createDemandOrg('ngo', 12.9720, 77.5950);
  const demandId = uuidv4();
  const safeFuture = new Date(Date.now() + 6 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, quantity_unit, urgency, required_by, status)
    VALUES (?, ?, 'bakery', 20, 'pieces', 'emergency', ?, 'open')
  `).run(demandId, recipientId, safeFuture);

  // Surplus of 50 rolls of bakery
  const surplusId = uuidv4();
  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Fresh Bread Rolls', 'bakery', 50, 50, 'pieces', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), safeFuture);

  // Trigger matching from DEMAND registration side (Path B)
  runUnifiedMatching({ demandId });

  const demand = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(demandId);
  assert.strictEqual(demand.status, 'fulfilled', 'Demand should be fulfilled');
  assert.strictEqual(demand.remaining_quantity, 0);

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  // The leftover 30 pieces should have been routed to food bank fallback, so remaining_quantity is 0 and status is matched!
  assert.strictEqual(surplus.status, 'matched', 'Leftover surplus must be routed and marked matched');
  assert.strictEqual(surplus.remaining_quantity, 0, 'Leftover surplus quantity must be fully resolved');

  const fbAllocation = db.prepare('SELECT * FROM matches WHERE surplus_id = ? AND notes = ?').get(surplusId, 'fallback_food_bank');
  assert.ok(fbAllocation, 'Food bank fallback allocation must exist for leftover surplus');
  assert.strictEqual(fbAllocation.allocated_quantity, 30);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Missing donor location consistently routes to review (even with long expiry)
// ─────────────────────────────────────────────────────────────────────────────
it('Missing donor location consistently triggers manual review even with long expiry window', () => {
  const donorId = createDonorOrg(0, 0); // No registered GPS coordinates
  const surplusId = uuidv4();
  const longExpiry = new Date(Date.now() + 10 * 3600 * 1000).toISOString(); // 10 hours left

  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Unlocated Sandwiches', 'cooked_meals', 30, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, new Date().toISOString(), longExpiry);

  runUnifiedMatching({ surplusId });

  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'review_required', 'Must be flagged for operator review');
  assert.ok(surplus.review_reason.includes('Donor location is missing or uncertain'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: Demand matching encounters expired surplus and actively routes to biogas
// ─────────────────────────────────────────────────────────────────────────────
it('Demand matching encounters expired surplus and actively routes it to biogas', () => {
  const donorId = createDonorOrg(12.9716, 77.5946);
  const surplusId = uuidv4();
  const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // Expired 1 hour ago

  // Lingering surplus in available state
  db.prepare(`
    INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit, availability_time, remaining_usable_time, status)
    VALUES (?, ?, 'Lingering Stale Food', 'cooked_meals', 40, 'servings', ?, ?, 'available')
  `).run(surplusId, donorId, pastExpiry, pastExpiry);

  // Recipient posts demand
  const recipientId = createDemandOrg('ngo', 12.9720, 77.5950);
  const demandId = uuidv4();
  const safeFuture = new Date(Date.now() + 4 * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, quantity_unit, urgency, required_by, status)
    VALUES (?, ?, 'cooked_meals', 10, 'servings', 'regular', ?, 'open')
  `).run(demandId, recipientId, safeFuture);

  runUnifiedMatching({ demandId });

  // The expired surplus must NOT just be skipped — it must be transitioned to biogas_routed!
  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(surplus.status, 'biogas_routed', 'Expired surplus must be actively routed to biogas');
  assert.ok(surplus.biogas_reason.includes('expired'));

  const biogasRecord = db.prepare('SELECT * FROM biogas_routes WHERE surplus_id = ?').get(surplusId);
  assert.ok(biogasRecord, 'Biogas route audit record must be recorded');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`Results: ${passed}/${passed + failed} tests passed`);
console.log('═══════════════════════════════════════════════════════════════');

if (failed > 0) process.exit(1);

