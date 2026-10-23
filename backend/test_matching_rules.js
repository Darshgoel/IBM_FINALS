const assert = require('assert');
const db = require('./database/db');
const { v4: uuidv4 } = require('uuid');
const {
  runUnifiedMatching,
  checkCompatibility,
  rankCandidate,
  convertQuantity
} = require('./services/matching');

console.log('═══════════════════════════════════════════════════════════════');
console.log('🧪 Matching Rules Verification Test Suite');
console.log('═══════════════════════════════════════════════════════════════\n');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAIL: ${name}`);
    console.error(err);
  }
}

// ── TEST 1: Rule 1 - Food Type Gate ──────────────────────────────────────────
test('Rule 1 - Incompatible food types are rejected before scoring', () => {
  const surplus = {
    food_name: 'Fresh Whole Milk',
    food_type: 'dairy',
    quantity: 20,
    remaining_quantity: 20,
    quantity_unit: 'liters',
    dietary_tags: '["dairy"]',
    remaining_usable_time: new Date(Date.now() + 6 * 3600000).toISOString()
  };
  const demand = {
    food_requirement: 'Cooked Hot Dinner Meals',
    quantity_needed: 20,
    remaining_quantity: 20,
    quantity_unit: 'servings',
    dietary_requirements: '[]',
    required_by: new Date(Date.now() + 4 * 3600000).toISOString(),
    urgency: 'regular',
    status: 'open'
  };

  const gate = checkCompatibility(surplus, demand, null, null, null);
  assert.strictEqual(gate.pass, false, 'Should fail compatibility gate');
  assert(gate.reason.includes('Food type mismatch'), 'Reason should cite food type mismatch');
});

// ── TEST 2: Rule 1 - Dietary / Allergen Safety Gate ─────────────────────────
test('Rule 1 - Dietary safety constraints are hard gates (not score bonuses)', () => {
  const surplus = {
    food_name: 'Chicken Biryani',
    food_type: 'cooked_meals',
    quantity: 50,
    remaining_quantity: 50,
    quantity_unit: 'servings',
    dietary_tags: '["non_veg"]',
    remaining_usable_time: new Date(Date.now() + 4 * 3600000).toISOString()
  };
  const demand = {
    food_requirement: 'Cooked meals',
    quantity_needed: 40,
    remaining_quantity: 40,
    quantity_unit: 'servings',
    dietary_requirements: '["vegetarian"]',
    required_by: new Date(Date.now() + 3 * 3600000).toISOString(),
    urgency: 'immediate',
    status: 'open'
  };

  const gate = checkCompatibility(surplus, demand, null, null, null);
  assert.strictEqual(gate.pass, false, 'Should fail due to dietary safety constraint');
  assert(gate.reason.includes('Dietary safety constraint violated'), 'Reason should cite dietary violation');
});

// ── TEST 3: Rule 1 - Usability & Expiry / Deadline Gate ──────────────────────
test('Rule 1 - Food expiring before arrival or after demand deadline is rejected', () => {
  const surplus = {
    food_name: 'Sandwiches',
    food_type: 'cooked_meals',
    quantity: 30,
    remaining_quantity: 30,
    quantity_unit: 'servings',
    dietary_tags: '["vegetarian"]',
    // Expires in 10 minutes, but transit takes at least 40 minutes!
    remaining_usable_time: new Date(Date.now() + 10 * 60000).toISOString()
  };
  const demand = {
    food_requirement: 'cooked_meals',
    quantity_needed: 25,
    remaining_quantity: 25,
    quantity_unit: 'servings',
    dietary_requirements: '["vegetarian"]',
    required_by: new Date(Date.now() + 2 * 3600000).toISOString(),
    urgency: 'regular',
    status: 'open'
  };

  const donorOrg = { location_lat: 12.9716, location_lng: 77.5946 };
  const demandOrg = { location_lat: 12.9340, location_lng: 77.6225 };

  const gate = checkCompatibility(surplus, demand, donorOrg, demandOrg, null);
  assert.strictEqual(gate.pass, false, 'Should fail because food cannot arrive before expiring');
  assert(gate.reason.includes('Food cannot arrive before expiration'), 'Reason should cite expiry window');
});

// ── TEST 4: Rule 1 - Recipient Storage Capacity Gate ─────────────────────────
test('Rule 1 - Recipient lacking cold storage cannot be allocated perishable food', () => {
  const surplus = {
    food_name: 'Fresh Dairy Yogurt & Milk',
    food_type: 'dairy',
    quantity: 25,
    remaining_quantity: 25,
    quantity_unit: 'liters',
    dietary_tags: '["dairy"]',
    remaining_usable_time: new Date(Date.now() + 5 * 3600000).toISOString()
  };
  const demand = {
    food_requirement: 'dairy',
    quantity_needed: 20,
    remaining_quantity: 20,
    quantity_unit: 'liters',
    dietary_requirements: '[]',
    required_by: new Date(Date.now() + 4 * 3600000).toISOString(),
    urgency: 'regular',
    status: 'open'
  };
  const profile = {
    storage_capacity: 'Dry storage only, no refrigeration',
    serving_capacity: 100
  };

  const gate = checkCompatibility(surplus, demand, null, null, profile);
  assert.strictEqual(gate.pass, false, 'Should reject allocation if storage lacks refrigeration');
  assert(gate.reason.includes('lacks cold storage'), 'Reason should cite lack of cold storage');
});

function cleanupTestRecords() {
  db.exec(`
    DELETE FROM matches WHERE demand_org_id IN (SELECT id FROM organizations WHERE name LIKE 'Test %' OR name LIKE '% Test' OR name LIKE '% Test %' OR name = 'Grand Bakery' OR name = 'Children Haven');
    DELETE FROM matches WHERE surplus_id IN (SELECT id FROM surplus_posts WHERE donor_org_id IN (SELECT id FROM organizations WHERE name LIKE 'Test %' OR name LIKE '% Test' OR name LIKE '% Test %' OR name = 'Grand Bakery' OR name = 'Children Haven'));
    DELETE FROM demand_registrations WHERE demand_org_id IN (SELECT id FROM organizations WHERE name LIKE 'Test %' OR name LIKE '% Test' OR name LIKE '% Test %' OR name = 'Grand Bakery' OR name = 'Children Haven');
    DELETE FROM surplus_posts WHERE donor_org_id IN (SELECT id FROM organizations WHERE name LIKE 'Test %' OR name LIKE '% Test' OR name LIKE '% Test %' OR name = 'Grand Bakery' OR name = 'Children Haven');
    DELETE FROM demand_org_profiles WHERE org_id IN (SELECT id FROM organizations WHERE name LIKE 'Test %' OR name LIKE '% Test' OR name LIKE '% Test %' OR name = 'Grand Bakery' OR name = 'Children Haven');
    DELETE FROM organizations WHERE name LIKE 'Test %' OR name LIKE '% Test' OR name LIKE '% Test %' OR name = 'Grand Bakery' OR name = 'Children Haven';
  `);
}

// ── TEST 5: Rule 2 - Actual Quantity Calculation & Inventory Tracking ────────
test('Rule 2 - Multi-demand allocation splits surplus quantity accurately', () => {
  cleanupTestRecords();
  const uniqueFood = 'curry_rice_' + Date.now();

  // Create donor & recipient organizations for isolated testing
  const donorOrgId = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_lat, location_lng, status, verified)
    VALUES (?, 'Test Grand Kitchen', 'hotel', 12.9716, 77.5946, 'active', 1)`).run(donorOrgId);

  const ngo1Id = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_lat, location_lng, status, verified)
    VALUES (?, 'Test Shelter North', 'shelter', 12.9780, 77.5990, 'active', 1)`).run(ngo1Id);
  db.prepare(`INSERT INTO demand_org_profiles (org_id, serving_capacity, storage_capacity) VALUES (?, 200, 'Refrigerated')`).run(ngo1Id);

  const ngo2Id = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_lat, location_lng, status, verified)
    VALUES (?, 'Test Shelter South', 'shelter', 12.9650, 77.6010, 'active', 1)`).run(ngo2Id);
  db.prepare(`INSERT INTO demand_org_profiles (org_id, serving_capacity, storage_capacity) VALUES (?, 200, 'Refrigerated')`).run(ngo2Id);

  // Demand 1: needs 40 servings
  const dem1Id = uuidv4();
  db.prepare(`INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit, urgency, status, required_by)
    VALUES (?, ?, ?, 40, 40, 'servings', 'emergency', 'open', datetime('now', '+3 hours'))`).run(dem1Id, ngo1Id, uniqueFood);

  // Demand 2: needs 50 servings
  const dem2Id = uuidv4();
  db.prepare(`INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit, urgency, status, required_by)
    VALUES (?, ?, ?, 50, 50, 'servings', 'immediate', 'open', datetime('now', '+4 hours'))`).run(dem2Id, ngo2Id, uniqueFood);

  // Surplus: 70 servings available
  const surplusId = uuidv4();
  db.prepare(`INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, dietary_tags, remaining_usable_time, status)
    VALUES (?, ?, ?, ?, 70, 70, 'servings', '["vegetarian"]', datetime('now', '+5 hours'), 'available')`).run(surplusId, donorOrgId, 'Fresh ' + uniqueFood, uniqueFood);

  // Run matching for surplus
  const matchResult = runUnifiedMatching({ surplusId });
  assert(matchResult !== null, 'Matching should create match');

  // Verify Demand 1 was fulfilled (allocated 40 servings)
  const d1 = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(dem1Id);
  assert.strictEqual(d1.remaining_quantity, 0, 'Demand 1 remaining should be 0');
  assert.strictEqual(d1.status, 'fulfilled', 'Demand 1 status should be fulfilled');

  // Verify Demand 2 was partially fulfilled (allocated 30 of 50, remaining 20)
  const d2 = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(dem2Id);
  assert.strictEqual(d2.remaining_quantity, 20, 'Demand 2 remaining should be 20');
  assert.strictEqual(d2.status, 'partially_fulfilled', 'Demand 2 status should be partially_fulfilled');

  // Verify Surplus was fully allocated (70 - 40 - 30 = 0)
  const sp = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(sp.remaining_quantity, 0, 'Surplus remaining should be 0');
  assert.strictEqual(sp.status, 'matched', 'Surplus status should be matched');

  // Verify matches table recorded exact allocated quantities
  const matches = db.prepare('SELECT * FROM matches WHERE surplus_id = ? ORDER BY allocated_quantity DESC').all(surplusId);
  assert.strictEqual(matches.length, 2, 'Should create 2 allocations for 2 demands');
  assert.strictEqual(matches[0].allocated_quantity, 40, 'First match allocated 40');
  assert.strictEqual(matches[1].allocated_quantity, 30, 'Second match allocated 30');
});

// ── TEST 6: Rule 3 & 4 - Unified Process & Explainable Ranking ────────────────
test('Rule 3 & 4 - Recipient posting demand triggers unified matching with explainable reasons', () => {
  cleanupTestRecords();
  const uniqueBakery = 'artisan_bread_' + Date.now();

  const donorOrgId = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_lat, location_lng, status, verified)
    VALUES (?, 'Grand Bakery', 'bakery', 12.9716, 77.5946, 'active', 1)`).run(donorOrgId);

  const ngoOrgId = uuidv4();
  db.prepare(`INSERT INTO organizations (id, name, type, location_lat, location_lng, status, verified)
    VALUES (?, 'Children Haven', 'shelter', 12.9740, 77.5980, 'active', 1)`).run(ngoOrgId);
  db.prepare(`INSERT INTO demand_org_profiles (org_id, serving_capacity, storage_capacity) VALUES (?, 150, 'Dry pantry')`).run(ngoOrgId);

  // Available surplus already in the network
  const surplusId = uuidv4();
  db.prepare(`INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit, dietary_tags, remaining_usable_time, status)
    VALUES (?, ?, ?, ?, 35, 35, 'servings', '["vegetarian"]', datetime('now', '+6 hours'), 'available')`).run(surplusId, donorOrgId, 'Fresh ' + uniqueBakery, uniqueBakery);

  // Recipient posts demand: 30 servings
  const demandId = uuidv4();
  db.prepare(`INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit, urgency, status, required_by)
    VALUES (?, ?, ?, 30, 30, 'servings', 'emergency', 'open', datetime('now', '+4 hours'))`).run(demandId, ngoOrgId, uniqueBakery);

  // Recipient path calls unified matcher
  const matchResult = runUnifiedMatching({ demandId });
  assert(matchResult !== null, 'Should match demand against available surplus');
  assert.strictEqual(matchResult.allocatedQuantity, 30, 'Should allocate 30 servings');

  // Verify match has explainable reasoning
  assert(matchResult.explanation && matchResult.explanation.length > 10, 'Must have human-readable explanation');
  assert(matchResult.explanation.includes('coverage') || matchResult.explanation.includes('Covers'), 'Explanation should explain coverage');

  const matchRow = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchResult.matchId);
  assert(matchRow.explanation && matchRow.explanation.includes('Covers'), 'Explanation stored in matches table');

  // Surplus remainder (5 servings) was finished via food bank fallback per flowchart
  const sp = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
  assert.strictEqual(sp.remaining_quantity, 0, 'Leftover surplus quantity routed to food bank');
  assert.strictEqual(sp.status, 'matched', 'Surplus fully routed');

  const fbMatch = db.prepare('SELECT * FROM matches WHERE surplus_id = ? AND notes = ?').get(surplusId, 'fallback_food_bank');
  assert.ok(fbMatch, 'Food bank fallback allocation exists for the leftover 5 servings');
  assert.strictEqual(fbMatch.allocated_quantity, 5);
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`Results: ${passedTests}/${totalTests} tests passed`);
console.log('═══════════════════════════════════════════════════════════════\n');
