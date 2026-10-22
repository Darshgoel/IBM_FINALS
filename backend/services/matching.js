/**
 * Matching Service
 * Automatically finds the best demand recipient for a surplus post.
 * Scoring factors: urgency, food compatibility, remaining time, distance.
 */

const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const URGENCY_WEIGHT = { emergency: 1.0, immediate: 0.75, regular: 0.5, planned: 0.25 };
const MAX_MATCH_DISTANCE_KM = 50;

function scoreDemandForSurplus(surplus, demand, demandOrg, donorOrg) {
  let score = 0;

  // Urgency score (0-40 points)
  score += (URGENCY_WEIGHT[demand.urgency] || 0.5) * 40;

  // Time compatibility (0-30 points): does surplus expire before demand is needed?
  const surplusExpiry = new Date(surplus.remaining_usable_time).getTime();
  const demandNeeded = new Date(demand.required_by).getTime();
  const now = Date.now();
  const timeBuffer = surplusExpiry - now;
  if (timeBuffer > 0 && (demandNeeded <= surplusExpiry || !demand.required_by)) {
    score += 30 * Math.min(1, timeBuffer / (4 * 3600 * 1000)); // More time = better score
  }

  // Distance score (0-20 points)
  if (donorOrg && demandOrg && donorOrg.location_lat && demandOrg.location_lat) {
    const dist = haversineDistance(
      donorOrg.location_lat, donorOrg.location_lng,
      demandOrg.location_lat, demandOrg.location_lng
    );
    if (dist <= MAX_MATCH_DISTANCE_KM) {
      score += 20 * (1 - dist / MAX_MATCH_DISTANCE_KM);
    }
  } else {
    score += 10; // Neutral if no location data
  }

  // Quantity feasibility (0-10 points)
  if (demand.quantity_needed && surplus.quantity) {
    const ratio = Math.min(surplus.quantity, demand.quantity_needed) / demand.quantity_needed;
    score += 10 * ratio;
  } else {
    score += 5;
  }

  return Math.round(score);
}

function runMatching(surplusId) {
  const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ? AND status = ?').get(surplusId, 'available');
  if (!surplus) return null;

  const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(surplus.donor_org_id);

  // Find all open demand registrations from active orgs
  const demands = db.prepare(`
    SELECT dr.*, o.location_lat, o.location_lng, o.status as org_status
    FROM demand_registrations dr
    JOIN organizations o ON dr.demand_org_id = o.id
    WHERE dr.status IN ('open','partially_fulfilled')
    AND o.status = 'active'
    ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 WHEN 'regular' THEN 3 WHEN 'planned' THEN 4 END
  `).all();

  if (!demands.length) return null;

  let bestDemand = null;
  let bestScore = -1;

  for (const demand of demands) {
    const demandOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(demand.demand_org_id);
    const score = scoreDemandForSurplus(surplus, demand, demandOrg, donorOrg);
    if (score > bestScore) {
      bestScore = score;
      bestDemand = demand;
    }
  }

  if (!bestDemand || bestScore < 10) {
    // Try fallback to food bank / reserve
    return tryFallbackAllocation(surplus, donorOrg);
  }

  // Create match
  const matchId = uuidv4();
  db.prepare(`
    INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(matchId, surplusId, bestDemand.id, bestDemand.demand_org_id, bestScore);

  // Update surplus status
  db.prepare("UPDATE surplus_posts SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(surplusId);

  // Update demand status
  db.prepare("UPDATE demand_registrations SET status = 'partially_fulfilled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(bestDemand.id);

  // Create alerts
  createAlert(bestDemand.demand_org_id, null, 'match', '🍱 Food Match Found!',
    `Surplus food has been matched to your demand. Check your dashboard for details.`);

  createAlert(surplus.donor_org_id, null, 'match', '✅ Surplus Matched',
    `Your surplus post has been matched with a recipient. Sit back — we handle the rest.`);

  console.log(`[Matching] Surplus ${surplusId} matched to demand ${bestDemand.id} (score: ${bestScore})`);
  return { matchId, demandId: bestDemand.id, score: bestScore };
}

function tryFallbackAllocation(surplus, donorOrg) {
  // Look for demand orgs that can act as food banks (no immediate demand, but can receive)
  const foodBanks = db.prepare(`
    SELECT o.* FROM organizations o
    JOIN demand_org_profiles dp ON o.id = dp.org_id
    WHERE o.status = 'active' AND o.type LIKE '%food_bank%'
    LIMIT 1
  `).get();

  if (!foodBanks) {
    console.log(`[Matching] No fallback found for surplus ${surplus.id}`);
    return null;
  }

  const matchId = uuidv4();
  db.prepare(`
    INSERT INTO matches (id, surplus_id, demand_org_id, match_score, status, notes)
    VALUES (?, ?, ?, ?, 'pending', 'fallback_food_bank')
  `).run(matchId, surplus.id, foodBanks.id, 30);

  db.prepare("UPDATE surplus_posts SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(surplus.id);

  createAlert(surplus.donor_org_id, null, 'fallback', '🏦 Surplus Routed to Reserve',
    `No immediate demand found. Your surplus has been routed to a food bank for future distribution.`);

  return { matchId, fallback: true };
}

function createAlert(orgId, userId, type, title, message) {
  try {
    const { dispatchNotification } = require('./notifications');
    dispatchNotification({ orgId, userId, type, title, message });
  } catch (err) {
    const { v4: uuid } = require('uuid');
    db.prepare('INSERT INTO alerts (id, org_id, user_id, type, title, message) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid(), orgId, userId, type, title, message);
  }
}

function generateSurplusPredictions(donorOrgId) {
  // Simple moving average from last 30 days of surplus posts
  const history = db.prepare(`
    SELECT quantity, food_type, created_at FROM surplus_posts
    WHERE donor_org_id = ? AND created_at >= date('now', '-30 days')
    ORDER BY created_at DESC
  `).all(donorOrgId);

  if (history.length < 2) return null;

  const avgQty = history.reduce((s, r) => s + r.quantity, 0) / history.length;
  const foodTypeCounts = {};
  history.forEach(r => { foodTypeCounts[r.food_type] = (foodTypeCounts[r.food_type] || 0) + 1; });
  const dominantType = Object.entries(foodTypeCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const confidence = Math.min(0.95, 0.3 + history.length * 0.02);

  return { predictedQuantity: Math.round(avgQty * 10) / 10, predictedFoodType: dominantType, confidence };
}

module.exports = { runMatching, generateSurplusPredictions, createAlert };
