/*
 * End-to-end checks for the four FoodBridge partner roles.
 *
 * Run against a local test server after creating and approving one dummy donor,
 * NGO, food bank, and biogas operator. The database must be a test-only network
 * with no other open demands, available donor surplus, or usable food-bank stock.
 * The script creates uniquely named records over the HTTP API and removes only
 * those records when it exits. It never creates, deletes, or changes accounts.
 *
 * Required environment variables:
 *   FOODBRIDGE_TEST_DONOR_EMAIL / FOODBRIDGE_TEST_DONOR_PASSWORD
 *   FOODBRIDGE_TEST_NGO_EMAIL / FOODBRIDGE_TEST_NGO_PASSWORD
 *   FOODBRIDGE_TEST_FOOD_BANK_EMAIL / FOODBRIDGE_TEST_FOOD_BANK_PASSWORD
 *   FOODBRIDGE_TEST_BIOGAS_EMAIL / FOODBRIDGE_TEST_BIOGAS_PASSWORD
 * Optional:
 *   FOODBRIDGE_TEST_BASE_URL (default http://localhost:3000)
 *   FOODBRIDGE_TEST_FOOD_TYPE (default packaged)
 *   FOODBRIDGE_TEST_KEEP_DATA=1 (leave test records for inspection)
 *   FOODBRIDGE_DB_PATH (must match the running server if using a non-default DB)
 */

'use strict';

const path = require('path');
const { randomUUID } = require('crypto');

const baseUrl = (process.env.FOODBRIDGE_TEST_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const foodType = (process.env.FOODBRIDGE_TEST_FOOD_TYPE || 'packaged').trim().toLowerCase();
const keepData = process.env.FOODBRIDGE_TEST_KEEP_DATA === '1';
const dbPath = process.env.FOODBRIDGE_DB_PATH || path.join(__dirname, 'database', 'foodbridge.db');

const partnerConfig = [
  ['donor', 'FOODBRIDGE_TEST_DONOR_EMAIL', 'FOODBRIDGE_TEST_DONOR_PASSWORD', 'donor'],
  ['ngo', 'FOODBRIDGE_TEST_NGO_EMAIL', 'FOODBRIDGE_TEST_NGO_PASSWORD', 'demand_org'],
  ['foodBank', 'FOODBRIDGE_TEST_FOOD_BANK_EMAIL', 'FOODBRIDGE_TEST_FOOD_BANK_PASSWORD', 'food_bank'],
  ['biogas', 'FOODBRIDGE_TEST_BIOGAS_EMAIL', 'FOODBRIDGE_TEST_BIOGAS_PASSWORD', 'biogas_operator']
];

const runId = `FBTEST-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
const artifacts = { demandIds: [], surplusIds: [], matchIds: [], inventoryIds: [], routeIds: [] };
const partnerOrgIds = [];
let alertRowidAtStart = 0;
let db;
let passed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function step(name) {
  return (fn) => async (...args) => {
    process.stdout.write(`\n[RUN] ${name}\n`);
    const result = await fn(...args);
    passed++;
    process.stdout.write(`[PASS] ${name}\n`);
    return result;
  };
}

async function api(route, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${route} returned ${response.status}: ${payload.error || JSON.stringify(payload)}`);
  }
  return payload;
}

async function loginPartners() {
  const partners = {};
  for (const [key, emailVar, passwordVar, expectedRole] of partnerConfig) {
    const email = process.env[emailVar];
    const password = process.env[passwordVar];
    assert(email && password, `Set ${emailVar} and ${passwordVar} for the dummy ${key} account.`);
    const result = await api('/api/auth/login', { method: 'POST', body: { email, password, scope: 'user' } });
    assert(result.user?.role === expectedRole, `${key} account must have role ${expectedRole}; got ${result.user?.role}.`);
    if (key !== 'biogas') assert(result.user.orgId, `${key} account is not linked to an organization.`);
    partners[key] = { ...result.user, token: result.token };
    if (key !== 'biogas') partnerOrgIds.push(result.user.orgId);
  }
  return partners;
}

function openApiDb() {
  // Pass the same DB path as the server so direct assertions and the expiry
  // worker exercise the exact records created through the API.
  process.env.FOODBRIDGE_DB_PATH = dbPath;
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return require('./services/matching');
}

function preflight(partners) {
  for (const [key, p] of Object.entries(partners)) {
    if (key === 'biogas') continue; // Biogas operators link directly to a facility, not organizations.
    const org = db.prepare('SELECT status, verified FROM organizations WHERE id = ?').get(p.orgId);
    assert(org && org.status === 'active' && Number(org.verified) === 1,
      `Organization for ${p.role} must be approved and active before running this test.`);
    const point = db.prepare('SELECT location_lat, location_lng FROM organizations WHERE id = ?').get(p.orgId);
    assert(Number.isFinite(Number(point.location_lat)) && Number.isFinite(Number(point.location_lng)) &&
      (Number(point.location_lat) !== 0 || Number(point.location_lng) !== 0),
    `Set valid map coordinates on the ${p.role} organization before running route matching.`);
  }

  const facility = db.prepare(`
    SELECT * FROM biogas_facilities WHERE operator_user_id = ? LIMIT 1
  `).get(partners.biogas.id);
  assert(facility, 'The biogas operator must have a linked facility.');
  assert(facility.status === 'active' && Number(facility.verified) === 1 && Number(facility.is_available) === 1,
    'The dummy biogas facility must be verified, active, and available.');
  assert(Number(facility.location_lat) !== 0 || Number(facility.location_lng) !== 0,
    'Set valid coordinates on the dummy biogas facility.');
  assert(Number(facility.max_daily_intake_kg) > 0,
    'Set a positive daily intake capacity on the dummy biogas facility.');
  const accepted = JSON.parse(facility.accepted_waste_types || '[]');
  assert(accepted.includes(foodType) || accepted.includes('all_food_waste'),
    `Biogas facility must accept ${foodType} or all_food_waste to test the expiry route.`);

  const donor = db.prepare('SELECT * FROM organizations WHERE id = ?').get(partners.donor.orgId);
  const foodBankProfile = db.prepare('SELECT * FROM demand_org_profiles WHERE org_id = ?').get(partners.foodBank.orgId);
  assert(foodBankProfile, 'Food-bank demand profile is missing.');
  const receiveCapacity = Number(foodBankProfile.receiving_capacity_kg || 0);
  assert(receiveCapacity > 0, 'Set receiving_capacity_kg above zero for the food-bank dummy.');
  const bankStorage = `${foodBankProfile.storage_capacity || ''} ${foodBankProfile.receiving_capacity || ''}`.toLowerCase();
  // This test uses a short-lived packaged item to avoid requiring chilled storage.
  assert(['packaged', 'bakery'].includes(foodType) || /cold|refrigerat|chill/.test(bankStorage),
    'For a non-cold-storage food bank, use FOODBRIDGE_TEST_FOOD_TYPE=packaged or bakery.');

  const contamination = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM demand_registrations WHERE status IN ('open','partially_fulfilled','searching')) AS open_demands,
      (SELECT COUNT(*) FROM surplus_posts WHERE status IN ('available','partially_matched') AND COALESCE(remaining_quantity, quantity) > 0.001) AS live_surplus,
      (SELECT COUNT(*) FROM food_bank_inventory WHERE COALESCE(quantity_remaining, 0) > 0.001
        AND expiry_date IS NOT NULL AND julianday(expiry_date) > julianday('now')
        AND COALESCE(biogas_status, 'available') = 'available') AS live_inventory
  `).get();
  assert(contamination.open_demands === 0 && contamination.live_surplus === 0 && contamination.live_inventory === 0,
    `Use a clean test network first (found ${contamination.open_demands} open demands, ${contamination.live_surplus} live surplus posts, ${contamination.live_inventory} usable inventory rows).`);

  alertRowidAtStart = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS id FROM alerts').get().id;
  return { facility, donor };
}

function testDemandRow(id) {
  const row = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(id);
  assert(row, `Demand ${id} was not persisted.`);
  return row;
}

function testSurplusRow(id) {
  const row = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(id);
  assert(row, `Surplus ${id} was not persisted.`);
  return row;
}

async function createDemand(partner, quantity, { recurring = false, requiredBy } = {}) {
  const result = await api('/api/demand-org/demand', {
    token: partner.token,
    method: 'POST',
    body: {
      foodRequirement: foodType,
      quantityNeeded: quantity,
      quantityUnit: 'kg',
      requiredBy: requiredBy || new Date(Date.now() + 2 * 3600000).toISOString(),
      urgency: 'regular',
      dietaryRequirements: [],
      isRecurring: recurring
    }
  });
  artifacts.demandIds.push(result.demandId);
  return result.demandId;
}

async function createSurplus(partner, quantity) {
  const result = await api('/api/donor/surplus', {
    token: partner.token,
    method: 'POST',
    body: {
      foodName: `${runId} ${foodType} test food`,
      foodType,
      quantity,
      quantityUnit: 'kg',
      preparationState: 'packaged sealed test stock',
      dietaryTags: [],
      availabilityTime: new Date().toISOString(),
      remainingUsableTime: new Date(Date.now() + 6 * 3600000).toISOString(),
      pickupAddress: 'Dummy test location'
    }
  });
  artifacts.surplusIds.push(result.surplusId);
  return result.surplusId;
}

async function runDirectDonorToNgo(partners, matching) {
  const ngoDemandId = await createDemand(partners.ngo, 1);
  const bankDemandId = await createDemand(partners.foodBank, 1);
  const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(partners.donor.orgId);
  const candidateOrgs = [partners.ngo, partners.foodBank].map(p =>
    db.prepare('SELECT id, location_lat, location_lng FROM organizations WHERE id = ?').get(p.orgId));
  const routes = await matching.precomputeRoutes(donorOrg, candidateOrgs);
  const routeDistances = candidateOrgs.map(org => ({
    id: org.id,
    distance: Number(routes.get(org.id)?.distanceKm)
  }));
  assert(routeDistances.every(row => Number.isFinite(row.distance)),
    'Could not calculate routes to both demand partners; verify coordinates and routing service availability.');
  const nearestDemandOrg = routeDistances.sort((a, b) => a.distance - b.distance)[0].id;
  const surplusId = await createSurplus(partners.donor, 1);
  const surplus = testSurplusRow(surplusId);
  const matches = db.prepare('SELECT * FROM matches WHERE surplus_id = ? AND demand_id IN (?, ?)')
    .all(surplusId, ngoDemandId, bankDemandId);
  assert(matches.length === 1, `Expected exactly one distance-priority match, found ${matches.length}.`);
  const match = matches[0];
  artifacts.matchIds.push(match.id);
  assert(match.source_type === 'surplus', `Expected donor surplus source, got ${match.source_type}.`);
  assert(Number(match.allocated_quantity) > 0, 'The direct match did not allocate any quantity.');
  assert(match.demand_org_id === nearestDemandOrg,
    `Distance priority chose ${match.demand_org_id}, but the nearest compatible demand is ${nearestDemandOrg}.`);
  assert(surplus.donor_org_id === partners.donor.orgId, 'Direct match has unexpected donor ownership.');
  const unfilledDemandId = match.demand_id === ngoDemandId ? bankDemandId : ngoDemandId;
  db.prepare("UPDATE demand_registrations SET status = 'expired' WHERE id = ?").run(unfilledDemandId);
}

async function runDonorToFoodBankReceipt(partners) {
  const surplusId = await createSurplus(partners.donor, 2);
  const match = db.prepare(`
    SELECT * FROM matches WHERE surplus_id = ? AND demand_org_id = ?
      AND notes LIKE '%fallback_food_bank%' ORDER BY matched_at DESC LIMIT 1
  `).get(surplusId, partners.foodBank.orgId);
  assert(match, 'No donor-to-food-bank fallback match was created. Check the bank coordinates, capacity, storage, and route ETA.');
  artifacts.matchIds.push(match.id);
  assert(Number(match.allocated_quantity) > 0, 'Food-bank fallback allocated no food.');

  await api(`/api/demand-org/matches/${match.id}/accept`, { token: partners.foodBank.token, method: 'PUT', body: {} });
  const accepted = db.prepare('SELECT status FROM matches WHERE id = ?').get(match.id);
  assert(accepted.status === 'confirmed', 'Food-bank match was not accepted before receipt confirmation.');

  const receipt = await api(`/api/demand-org/matches/${match.id}/confirm-receipt`, {
    token: partners.foodBank.token,
    method: 'POST',
    body: { quantityConfirmed: Number(match.allocated_quantity), quantityUnit: match.allocated_unit || 'kg', conditionOk: true }
  });
  assert(receipt.inventoryAdded, 'Food-bank receipt did not automatically create inventory.');
  const inventory = db.prepare('SELECT * FROM food_bank_inventory WHERE match_id = ?').get(match.id);
  assert(inventory, 'Food-bank receipt inventory row is missing.');
  artifacts.inventoryIds.push(inventory.id);
  const source = db.prepare('SELECT remaining_usable_time FROM surplus_posts WHERE id = ?').get(surplusId);
  const sourceExpiry = Date.parse(source.remaining_usable_time);
  const bankExpiry = Date.parse(inventory.expiry_date);
  assert(Number.isFinite(sourceExpiry) && Number.isFinite(bankExpiry), 'Could not parse donor and food-bank expiry timestamps.');
  const addedHours = (bankExpiry - sourceExpiry) / 3600000;
  assert(addedHours >= 2.95 && addedHours <= 3.05, `Food-bank receipt expiry should gain 3 hours; observed ${addedHours.toFixed(2)} hours.`);
  assert(Number(inventory.quantity_remaining) === Number(inventory.quantity_received), 'Received food-bank inventory quantity is not available.');
  return inventory;
}

async function runBankInventoryToDemand(partners, inventory) {
  const quantity = Math.min(1, Number(inventory.quantity_remaining));
  const demandId = await createDemand(partners.ngo, quantity);
  const match = db.prepare(`
    SELECT * FROM matches WHERE demand_id = ? AND source_type = 'food_bank_inventory'
      AND source_inventory_id = ? ORDER BY matched_at DESC LIMIT 1
  `).get(demandId, inventory.id);
  assert(match, 'Food-bank inventory did not match the NGO demand. Check inventory type, expiry, unit, distance, and NGO profile.');
  artifacts.matchIds.push(match.id);
  assert(match.demand_org_id === partners.ngo.orgId, 'Inventory match has the wrong receiving organization.');
  const after = db.prepare('SELECT quantity_remaining FROM food_bank_inventory WHERE id = ?').get(inventory.id);
  assert(Number(after.quantity_remaining) < Number(inventory.quantity_remaining), 'Inventory was not reserved when the demand matched.');
  return { demandId, matchId: match.id, beforeExpiryQty: Number(inventory.quantity_received) };
}

async function runExpiryToBiogas(partners, matching, pendingInventoryMatch) {
  // Expire the test bank lot only; the clean-network preflight protects all other stock.
  const inventory = db.prepare('SELECT * FROM food_bank_inventory WHERE id = ?').get(artifacts.inventoryIds[0]);
  assert(inventory, 'Test food-bank lot disappeared before expiry check.');
  db.prepare("UPDATE food_bank_inventory SET expiry_date = datetime('now', '-1 minute') WHERE id = ?").run(inventory.id);

  const result = await matching.processExpiredSurplus();
  assert(result.processedInventory >= 1, 'Expiry sweep did not process the expired food-bank lot.');
  const route = db.prepare(`
    SELECT * FROM biogas_routes WHERE source_type = 'food_bank_inventory' AND source_inventory_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(inventory.id);
  assert(route, 'Expiry sweep did not create a biogas route for food-bank inventory.');
  artifacts.routeIds.push(route.id);
  assert(route.biogas_facility_id === partners.biogas.biogasFacilityId,
    'Expired food was not assigned to the dummy operator facility.');
  assert(route.destination_name !== 'Biogas Centre', 'Expiry route used a generic destination instead of a real facility.');
  assert(Number(route.quantity) > 0, 'Biogas route has no assigned quantity.');
  assert(Math.abs(Number(route.quantity) - pendingInventoryMatch.beforeExpiryQty) < 0.001,
    'Biogas route did not include quantity reserved by the cancelled pending inventory match.');
  const cancelledMatch = db.prepare('SELECT status FROM matches WHERE id = ?').get(pendingInventoryMatch.matchId);
  assert(cancelledMatch.status === 'cancelled', 'Pending inventory match was not cancelled when its source expired.');
  assert(testDemandRow(pendingInventoryMatch.demandId).status === 'open',
    'Demand was not reopened after its pending inventory allocation expired.');
  const emptied = db.prepare('SELECT quantity_remaining, biogas_status FROM food_bank_inventory WHERE id = ?').get(inventory.id);
  assert(Number(emptied.quantity_remaining) === 0 && emptied.biogas_status === 'pending',
    'Expired bank stock was not removed from available inventory and marked pending for biogas.');

  const routeList = await api('/api/biogas/routes', { token: partners.biogas.token });
  assert((routeList.routes || []).some(row => row.id === route.id), 'Biogas operator API does not show its assigned route.');
  for (const status of ['accepted', 'received']) {
    await api(`/api/biogas/routes/${route.id}/status`, {
      token: partners.biogas.token, method: 'PUT', body: { status }
    });
  }
  const finalRoute = db.prepare('SELECT status FROM biogas_routes WHERE id = ?').get(route.id);
  const finalStock = db.prepare('SELECT biogas_status FROM food_bank_inventory WHERE id = ?').get(inventory.id);
  assert(finalRoute.status === 'received' && finalStock.biogas_status === 'received',
    'Biogas route lifecycle did not complete or inventory status was not synchronized.');
}

async function runDemandExpiryRules(partners, matching) {
  const deadline = new Date(Date.now() - 60_000).toISOString();
  const oneTime = await createDemand(partners.ngo, 3, { requiredBy: deadline });
  matching.expireOverdueDemands();
  assert(testDemandRow(oneTime).status === 'expired', 'Overdue one-time demand was not expired.');

  const recurring = await createDemand(partners.ngo, 3, { recurring: true, requiredBy: deadline });
  matching.expireOverdueDemands();
  assert(testDemandRow(recurring).status !== 'expired', 'Recurring demand was incorrectly expired.');
}

function cleanup() {
  if (!db || keepData) return;
  const unique = list => [...new Set(list.filter(Boolean))];
  const demands = unique(artifacts.demandIds);
  const surpluses = unique(artifacts.surplusIds);
  const inventoryIds = unique(artifacts.inventoryIds);
  const placeholders = values => values.length ? values.map(() => '?').join(',') : null;

  db.transaction(() => {
    const conditions = [];
    const args = [];
    if (demands.length) { conditions.push(`demand_id IN (${placeholders(demands)})`); args.push(...demands); }
    if (surpluses.length) { conditions.push(`surplus_id IN (${placeholders(surpluses)})`); args.push(...surpluses); }
    if (inventoryIds.length) { conditions.push(`source_inventory_id IN (${placeholders(inventoryIds)})`); args.push(...inventoryIds); }
    let matchIds = unique(artifacts.matchIds);
    if (conditions.length) {
      const found = db.prepare(`SELECT id FROM matches WHERE ${conditions.join(' OR ')}`).all(...args).map(row => row.id);
      matchIds = unique([...matchIds, ...found]);
    }
    if (matchIds.length) {
      const marks = placeholders(matchIds);
      db.prepare(`DELETE FROM receipt_confirmations WHERE match_id IN (${marks})`).run(...matchIds);
      db.prepare(`DELETE FROM matches WHERE id IN (${marks})`).run(...matchIds);
    }
    if (artifacts.routeIds.length) {
      db.prepare(`DELETE FROM biogas_routes WHERE id IN (${placeholders(artifacts.routeIds)})`).run(...artifacts.routeIds);
    }
    if (surpluses.length) db.prepare(`DELETE FROM biogas_routes WHERE surplus_id IN (${placeholders(surpluses)})`).run(...surpluses);
    if (inventoryIds.length) {
      db.prepare(`DELETE FROM biogas_routes WHERE source_inventory_id IN (${placeholders(inventoryIds)})`).run(...inventoryIds);
      db.prepare(`DELETE FROM food_bank_inventory WHERE id IN (${placeholders(inventoryIds)})`).run(...inventoryIds);
    }
    if (demands.length) db.prepare(`DELETE FROM demand_registrations WHERE id IN (${placeholders(demands)})`).run(...demands);
    if (surpluses.length) db.prepare(`DELETE FROM surplus_posts WHERE id IN (${placeholders(surpluses)})`).run(...surpluses);

    if (partnerOrgIds.length) {
      const orgMarks = placeholders(unique(partnerOrgIds));
      const alerts = db.prepare(`SELECT id FROM alerts WHERE rowid > ? AND org_id IN (${orgMarks})`).all(alertRowidAtStart, ...unique(partnerOrgIds)).map(row => row.id);
      if (alerts.length) {
        const alertMarks = placeholders(alerts);
        db.prepare(`DELETE FROM notification_deliveries WHERE alert_id IN (${alertMarks})`).run(...alerts);
        db.prepare(`DELETE FROM alerts WHERE id IN (${alertMarks})`).run(...alerts);
      }
    }
  })();
}

async function main() {
  assert(typeof fetch === 'function', 'Node.js 18 or newer is required (global fetch is unavailable).');
  const matching = openApiDb();
  const partners = await step('Sign in to all four dummy partner accounts and validate roles')(loginPartners)();
  const setup = await step('Check partner approval, coordinates, capacities, and clean test network')(preflight)(partners);
  assert(setup.facility.id === partners.biogas.biogasFacilityId, 'Biogas login is not linked to the facility found in the database.');

  await step('Match donor surplus to the nearer of two partner demands')(runDirectDonorToNgo)(partners, matching);
  const inventory = await step('Route unmatched donor surplus to food bank; accept receipt and add 3 hours to expiry')(runDonorToFoodBankReceipt)(partners);
  const pendingInventoryMatch = await step('Match in-date food-bank inventory to NGO demand')(runBankInventoryToDemand)(partners, inventory);
  await step('Route expired bank stock to its real biogas facility and complete the route')(runExpiryToBiogas)(partners, matching, pendingInventoryMatch);
  await step('Expire overdue one-time demand while preserving recurring demand')(runDemandExpiryRules)(partners, matching);

  process.stdout.write(`\nAll ${passed} partner flow checks passed.\n`);
  if (keepData) process.stdout.write(`Test records retained with run label ${runId} (FOODBRIDGE_TEST_KEEP_DATA=1).\n`);
}

main()
  .catch(error => {
    process.exitCode = 1;
    console.error(`\n[FAIL] ${error.stack || error.message}`);
  })
  .finally(() => {
    try {
      cleanup();
      if (db && !keepData) process.stdout.write('\nTest-created records were cleaned up.\n');
    } catch (error) {
      process.exitCode = 1;
      console.error(`\n[CLEANUP ERROR] ${error.stack || error.message}`);
    }
    if (db) db.close();
  });
