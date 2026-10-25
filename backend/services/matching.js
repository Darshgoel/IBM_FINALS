/**
 * Unified Matching Service
 *
 * Surplus routing lifecycle (per flowchart):
 *   1. Safety gate — expired or unsafe → biogas centre (hard stop, no consumption)
 *   2. Delivery feasibility — estimate transit time; if undeliverable → biogas;
 *      if data missing and time critical → manual review
 *   3. Demand matching — filter by food type, dietary safety, units, deadline,
 *      distance and recipient capacity; rank; allocate min(surplus_rem, demand_rem)
 *   4. Repeat while surplus remains
 *   5. Food bank fallback — check food type, cold storage, capacity AND delivery timing
 *   6. Operator review escalation — when no food bank confirmed and >2h until expiry
 *   7. Biogas for confirmed-undeliverable remainder (<2h until expiry, no destination)
 *   8. Record every allocation/destination, quantity, unit, status, reason; notify parties
 */

const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const { getRoute, haversineKm } = require('./routing');

const MAX_MATCH_DISTANCE_KM = 50;

// ── 1. DISTANCE UTILITY ───────────────────────────────────────────────────────

function haversineDistance(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const l1 = Number(lat1), ln1 = Number(lng1), l2 = Number(lat2), ln2 = Number(lng2);
  if (isNaN(l1) || isNaN(ln1) || isNaN(l2) || isNaN(ln2)) return null;
  if (l1 === 0 && ln1 === 0 && l2 === 0 && ln2 === 0) return null;
  const R = 6371;
  const dLat = ((l2 - l1) * Math.PI) / 180;
  const dLng = ((ln2 - ln1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((l1 * Math.PI) / 180) * Math.cos((l2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── 2. FOOD TAXONOMY & CLUSTERING ─────────────────────────────────────────────

const FOOD_CLUSTERS = {
  cooked_meals: [
    'cooked_meals', 'cooked_meal', 'hot_meals', 'hot_meal', 'prepared_meals', 'prepared_meal', 'meals', 'meal', 'rice_curry', 'cooked_food',
    'curry', 'pulav', 'pulao', 'biryani', 'dinner', 'lunch', 'breakfast', 'sandwiches', 'sandwich',
    'chapati', 'dal', 'paneer', 'roti', 'snack', 'snacks', 'cooked_snacks'
  ],
  produce: [
    'produce', 'vegetables', 'fruits', 'raw_vegetables', 'fresh_produce', 'raw', 'greens',
    'salad', 'salads', 'fruit_bowls'
  ],
  dairy: [
    'dairy', 'milk', 'yogurt', 'curd', 'cheese', 'paneer', 'butter', 'breakfast_beverages',
    'beverage', 'beverages'
  ],
  bakery: [
    'bakery', 'bread', 'pastries', 'desserts', 'biscuits', 'baked_goods', 'cakes', 'buns'
  ],
  packaged: [
    'packaged', 'grocery', 'canned', 'dry_goods', 'staples', 'dry_food', 'grains', 'pulses'
  ]
};

function normalizeString(str) {
  return String(str || '').toLowerCase().trim().replace(/[-_]+/g, ' ');
}

function findCluster(text) {
  const norm = normalizeString(text);
  for (const [clusterKey, synonyms] of Object.entries(FOOD_CLUSTERS)) {
    if (synonyms.some(s => norm.includes(normalizeString(s)))) return clusterKey;
  }
  return null;
}

/**
 * Checks whether surplus food is permitted by an organization's profile allowed food types.
 * Empty or wildcard ('all', 'any') allows all food types.
 * Otherwise, surplus food type or name or cluster must match at least one allowed tag.
 */
function isFoodAcceptedByProfile(surplusFoodType, surplusFoodName, profileRequirements) {
  const reqs = parseTags(profileRequirements);
  if (!reqs || reqs.length === 0) return true;

  const allowsAll = reqs.some(r => {
    const n = normalizeString(r);
    return n === 'all' || n === 'any' || n === 'all types' || n === 'all food' || n === 'everything';
  });
  if (allowsAll) return true;

  const surplusTypeNorm = normalizeString(surplusFoodType);
  const surplusNameNorm = normalizeString(surplusFoodName);
  const surplusCluster = findCluster(surplusFoodType) || findCluster(surplusFoodName);

  return reqs.some(r => {
    const pNorm = normalizeString(r);
    if (!pNorm) return false;
    if (pNorm === 'all' || pNorm === 'any' || pNorm === 'all types' || pNorm === 'all food') return true;

    if (surplusTypeNorm && (surplusTypeNorm.includes(pNorm) || pNorm.includes(surplusTypeNorm))) return true;
    if (surplusNameNorm && (surplusNameNorm.includes(pNorm) || pNorm.includes(surplusNameNorm))) return true;

    const pCluster = findCluster(r);
    if (pCluster && surplusCluster && pCluster === surplusCluster) return true;

    return false;
  });
}

function areFoodTypesCompatible(surplusFoodType, surplusFoodName, demandRequirement, profileRequirements) {
  const reqNorm = normalizeString(demandRequirement);
  const surplusTypeNorm = normalizeString(surplusFoodType);
  const surplusNameNorm = normalizeString(surplusFoodName);

  let matchesDemand = false;
  if (!reqNorm || reqNorm === 'all' || reqNorm === 'any' || reqNorm.includes('all types') || reqNorm.includes('all food')) {
    matchesDemand = true;
  } else if (surplusTypeNorm && (surplusTypeNorm.includes(reqNorm) || reqNorm.includes(surplusTypeNorm))) {
    matchesDemand = true;
  } else if (surplusNameNorm && (surplusNameNorm.includes(reqNorm) || reqNorm.includes(surplusNameNorm))) {
    matchesDemand = true;
  } else {
    const surplusCluster = findCluster(surplusFoodType) || findCluster(surplusFoodName);
    const demandCluster = findCluster(demandRequirement);
    if (surplusCluster && demandCluster && surplusCluster === demandCluster) {
      matchesDemand = true;
    }
  }

  if (!matchesDemand) return false;

  // Profile-level restrictions: if profile specifies restricted types, surplus must also be acceptable by the profile
  if (profileRequirements && (Array.isArray(profileRequirements) ? profileRequirements.length > 0 : String(profileRequirements).trim().length > 0)) {
    return isFoodAcceptedByProfile(surplusFoodType, surplusFoodName, profileRequirements);
  }

  return true;
}

// ── 3. DIETARY & ALLERGEN SAFETY VERIFICATION ─────────────────────────────────

const DIETARY_NORMALIZATION = {
  veg: 'vegetarian', vegetarian: 'vegetarian', vegan: 'vegan', halal: 'halal',
  kosher: 'kosher', jain: 'jain', jain_veg: 'jain',
  gluten_free: 'gluten_free', 'gluten-free': 'gluten_free',
  nut_free: 'nut_free', 'nut-free': 'nut_free', peanut_free: 'nut_free', 'peanut-free': 'nut_free',
  dairy_free: 'dairy_free', 'dairy-free': 'dairy_free', lactose_free: 'dairy_free',
  egg_free: 'egg_free', 'egg-free': 'egg_free'
};

function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {}
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function checkDietarySafety(surplusTagsRaw, demandDietaryRaw, profileRestrictionsRaw) {
  const surplusTags = parseTags(surplusTagsRaw).map(t => normalizeString(t).replace(/\s+/g, '_'));
  const demandReqs = parseTags(demandDietaryRaw).map(t => normalizeString(t).replace(/\s+/g, '_'));
  const profileReqs = parseTags(profileRestrictionsRaw).map(t => normalizeString(t).replace(/\s+/g, '_'));
  const requiredConstraints = Array.from(new Set([...demandReqs, ...profileReqs]));
  const availableTags = new Set(surplusTags.map(t => DIETARY_NORMALIZATION[t] || t));

  if (availableTags.has('vegan')) {
    availableTags.add('vegetarian');
    availableTags.add('dairy_free');
    availableTags.add('egg_free');
  }

  for (const rawConstraint of requiredConstraints) {
    const canonical = DIETARY_NORMALIZATION[rawConstraint] || rawConstraint;
    if (['hygienic', 'hot_meal', 'mild_spice', 'nutritious', 'clean', 'fresh'].includes(canonical)) continue;
    if (!availableTags.has(canonical)) {
      return {
        pass: false,
        reason: `Dietary safety constraint violated: recipient requires "${rawConstraint}", surplus only offers [${Array.from(availableTags).join(', ') || 'none'}]`
      };
    }
  }
  return { pass: true };
}

// ── 4. QUANTITY UNIT CONVERSIONS ──────────────────────────────────────────────

const UNIT_SYNONYMS = {
  kg: 'kg', kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  g: 'g', gram: 'g', grams: 'g',
  l: 'liters', liter: 'liters', liters: 'liters', litre: 'liters', litres: 'liters',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  serving: 'servings', servings: 'servings', portion: 'servings', portions: 'servings',
  meal: 'servings', meals: 'servings', plate: 'servings', plates: 'servings'
};

function convertQuantity(qty, fromUnitRaw, toUnitRaw, foodType) {
  const from = UNIT_SYNONYMS[normalizeString(fromUnitRaw)] || normalizeString(fromUnitRaw);
  const to = UNIT_SYNONYMS[normalizeString(toUnitRaw)] || normalizeString(toUnitRaw);
  if (from === to) return { success: true, convertedQty: qty };
  if (from === 'kg' && to === 'g') return { success: true, convertedQty: qty * 1000 };
  if (from === 'g' && to === 'kg') return { success: true, convertedQty: qty / 1000 };
  if (from === 'liters' && to === 'ml') return { success: true, convertedQty: qty * 1000 };
  if (from === 'ml' && to === 'liters') return { success: true, convertedQty: qty / 1000 };
  const isCooked = findCluster(foodType) === 'cooked_meals' || normalizeString(foodType).includes('cooked') || normalizeString(foodType).includes('meal');
  if (isCooked) {
    if (from === 'kg' && to === 'servings') return { success: true, convertedQty: Math.round(qty / 0.4) };
    if (from === 'servings' && to === 'kg') return { success: true, convertedQty: Math.round(qty * 0.4 * 10) / 10 };
  }
  const isDairy = findCluster(foodType) === 'dairy' || normalizeString(foodType).includes('milk');
  if (isDairy) {
    if (from === 'liters' && to === 'kg') return { success: true, convertedQty: qty };
    if (from === 'kg' && to === 'liters') return { success: true, convertedQty: qty };
    if (from === 'liters' && to === 'servings') return { success: true, convertedQty: Math.round(qty * 4) };
    if (from === 'servings' && to === 'liters') return { success: true, convertedQty: Math.round((qty / 4) * 10) / 10 };
  }
  return { success: false, reason: `Units "${fromUnitRaw}" and "${toUnitRaw}" cannot be safely converted for food type "${foodType}"` };
}

function parseSqliteDate(str) {
  if (!str) return null;
  if (typeof str !== 'string') return new Date(str).getTime();
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const endOfIndiaDay = new Date(`${s}T23:59:59.999+05:30`).getTime();
    return Number.isNaN(endOfIndiaDay) ? null : endOfIndiaDay;
  }
  const iso = s.includes('T')
    ? (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + '+05:30')
    : s.replace(' ', 'T') + '+05:30';
  const ts = new Date(iso).getTime();
  return isNaN(ts) ? new Date(str).getTime() : ts;
}

function parseInventoryExpiry(str) {
  if (!str) return null;
  const value = String(str).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const timestamp = new Date(`${value}T23:59:59.999+05:30`).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  const timestamp = parseSqliteDate(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

// ── 5. HARD COMPATIBILITY GATE ────────────────────────────────────────────────

function checkCompatibility(surplus, demand, donorOrg, demandOrg, demandProfile, routeResult) {
  // 1. Unfilled quantity check
  const surplusRem = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);
  const demandRem = demand.remaining_quantity != null ? Number(demand.remaining_quantity) : Number(demand.quantity_needed);

  if (surplusRem <= 0.001) return { pass: false, reason: 'Surplus has no remaining quantity available' };
  if (demandRem <= 0.001 || demand.status === 'fulfilled') return { pass: false, reason: 'Demand is already fully fulfilled' };

  // 2. Food type compatibility
  const profileFoodReqs = parseTags(demandProfile?.food_requirements);
  if (!areFoodTypesCompatible(surplus.food_type, surplus.food_name, demand.food_requirement, profileFoodReqs)) {
    return {
      pass: false,
      reason: `Food type mismatch: surplus "${surplus.food_name} (${surplus.food_type})" is incompatible with requested "${demand.food_requirement}"`
    };
  }

  // 3. Dietary & allergen safety gate (hard constraint)
  const dietaryCheck = checkDietarySafety(surplus.dietary_tags, demand.dietary_requirements, demandProfile?.dietary_restrictions);
  if (!dietaryCheck.pass) return dietaryCheck;

  // 4. Quantity unit comparability & conversion
  const unitConversion = convertQuantity(surplusRem, surplus.quantity_unit, demand.quantity_unit, surplus.food_type);
  if (!unitConversion.success) return { pass: false, reason: unitConversion.reason };

  // 5. Usability, transit & deadline arrival
  const now = Date.now();
  const surplusExpiry = parseSqliteDate(surplus.remaining_usable_time);
  if (isNaN(surplusExpiry) || surplusExpiry <= now) {
    return { pass: false, reason: 'Surplus food has already expired or has invalid expiry time' };
  }

  let distanceKm = null;
  let transitMinutes = 45;
  let routeProvider = 'haversine';

  if (routeResult && routeResult.distanceKm != null) {
    // Use pre-computed road distance
    distanceKm = routeResult.distanceKm;
    transitMinutes = Number.isFinite(Number(routeResult.durationMinutes))
      ? Math.round(Number(routeResult.durationMinutes))
      : Math.round(40 + (distanceKm / 25) * 60);
    routeProvider = routeResult.provider || 'osrm';
    if (distanceKm > MAX_MATCH_DISTANCE_KM) {
      return { pass: false, reason: `Road distance (${distanceKm.toFixed(1)} km) exceeds operational limit of ${MAX_MATCH_DISTANCE_KM} km` };
    }
  } else if (donorOrg?.location_lat && donorOrg?.location_lng && demandOrg?.location_lat && demandOrg?.location_lng) {
    distanceKm = haversineDistance(
      donorOrg.location_lat, donorOrg.location_lng,
      demandOrg.location_lat, demandOrg.location_lng
    );
    if (distanceKm !== null) {
      if (distanceKm > MAX_MATCH_DISTANCE_KM) {
        return { pass: false, reason: `Distance (${distanceKm.toFixed(1)} km) exceeds operational limit of ${MAX_MATCH_DISTANCE_KM} km` };
      }
      transitMinutes = Math.round(40 + (distanceKm / 25) * 60);
    }
  } else {
    return { pass: false, reason: 'Recipient location or route ETA is unavailable; manual review is required' };
  }

  const estimatedArrival = now + transitMinutes * 60 * 1000;
  const safeFreshnessBufferMs = surplusExpiry - estimatedArrival;
  if (safeFreshnessBufferMs < 15 * 60 * 1000) {
    return {
      pass: false,
      reason: `Food cannot arrive before expiration (estimated arrival: ${new Date(estimatedArrival).toLocaleTimeString()}, safe until: ${new Date(surplusExpiry).toLocaleTimeString()})`
    };
  }

  // Recurring requests are standing needs; their stored deadline belongs to an
  // occurrence and must not permanently block later matching cycles.
  if (demand.required_by && !Number(demand.is_recurring)) {
    const demandDeadline = parseSqliteDate(demand.required_by);
    if (!isNaN(demandDeadline)) {
      if (estimatedArrival > demandDeadline) {
        return {
          pass: false,
          reason: `Estimated arrival (${new Date(estimatedArrival).toLocaleTimeString()}) is after recipient deadline (${new Date(demandDeadline).toLocaleTimeString()})`
        };
      }
      // A later expiry is safe and should not disqualify the donation. The
      // arrival deadline above is the relevant demand constraint; the separate
      // freshness-buffer gate ensures the food remains safe on arrival.
    }
  }

  // 6. Recipient capacity & storage
  const convertedSurplus = unitConversion.convertedQty;
  const potentialAlloc = Math.min(convertedSurplus, demandRem);

  if (demandProfile) {
    if (demandProfile.serving_capacity && demandProfile.serving_capacity > 0) {
      const cap = Number(demandProfile.serving_capacity);
      const demUnit = (demand.quantity_unit || '').toLowerCase();
      const isServingUnit = ['servings', 'serving', 'portion', 'portions', 'meal', 'meals', 'plate', 'plates'].includes(demUnit);
      if (isServingUnit && potentialAlloc > cap) {
        return { pass: false, reason: `Allocated amount (${potentialAlloc} ${demUnit}) exceeds recipient serving capacity (${cap} servings)` };
      }
    }

    if (demandProfile.receiving_capacity) {
      const rcStr = String(demandProfile.receiving_capacity).trim();
      const rcMatch = rcStr.match(/^(\d+(?:\.\d+)?)\s*(\w+)?/);
      if (rcMatch) {
        const rcQty = parseFloat(rcMatch[1]);
        const rcUnitRaw = (rcMatch[2] || demand.quantity_unit || '').toLowerCase();
        const demUnitRaw = (demand.quantity_unit || '').toLowerCase();
        const fromNorm = UNIT_SYNONYMS[normalizeString(rcUnitRaw)] || normalizeString(rcUnitRaw);
        const toNorm = UNIT_SYNONYMS[normalizeString(demUnitRaw)] || normalizeString(demUnitRaw);
        if (!isNaN(rcQty) && rcQty > 0 && fromNorm === toNorm && potentialAlloc > rcQty) {
          return { pass: false, reason: `Delivery quantity (${potentialAlloc} ${demand.quantity_unit}) exceeds recipient receiving capacity (${rcStr})` };
        }
      }
    }

    const isPerishable = findCluster(surplus.food_type) === 'dairy' ||
      findCluster(surplus.food_type) === 'cooked_meals' ||
      normalizeString(surplus.food_type).includes('dairy');
    const storageStr = String(demandProfile.storage_capacity || '').trim();
    if (isPerishable && storageStr.length > 0) {
      const explicitlyLacksCold = /(no cold|no fridge|no refrig|dry only|dry storage only|dry storage\b)/i.test(storageStr);
      const hasCold = /(?<!no |without )(refrigerat(?!ion\b)|cold storage|freezer|chilled|cold chain)/i.test(storageStr);
      if (explicitlyLacksCold && !hasCold) {
        return { pass: false, reason: `Recipient lacks cold storage required for perishable surplus (${surplus.food_type})` };
      }
    }
  }

  return { pass: true, distanceKm, transitMinutes, routeProvider, estimatedArrival, surplusExpiry, convertedSurplus, potentialAlloc, surplusRem, demandRem };
}

// ── 6. EXPLAINABLE RANKING ENGINE ─────────────────────────────────────────────

const URGENCY_POINTS = { emergency: 15, immediate: 11, regular: 7, planned: 3 };

function rankCandidate(gateResult, surplus, demand, demandOrg) {
  let score = 0;
  const factors = {};

  let urgencyPts = URGENCY_POINTS[demand.urgency] || 7;
  let deadlinePts = 2;
  if (demand.required_by && !Number(demand.is_recurring)) {
    const diffHours = (parseSqliteDate(demand.required_by) - Date.now()) / 3600000;
    if (diffHours <= 2) deadlinePts = 10;
    else if (diffHours <= 4) deadlinePts = 7;
    else if (diffHours <= 8) deadlinePts = 4;
  }
  factors.urgency = urgencyPts + deadlinePts;
  score += factors.urgency;

  const safeHours = (gateResult.surplusExpiry - gateResult.estimatedArrival) / 3600000;
  let expiryPts = 8;
  if (safeHours <= 2) expiryPts = 20;
  else if (safeHours <= 4) expiryPts = 16;
  else if (safeHours <= 8) expiryPts = 12;
  factors.timeToExpiry = expiryPts;
  score += factors.timeToExpiry;

  let distPts = 10;
  if (gateResult.distanceKm !== null) {
    const d = gateResult.distanceKm;
    if (d <= 3) distPts = 20;
    else if (d <= 8) distPts = 16;
    else if (d <= 15) distPts = 12;
    else if (d <= 30) distPts = 8;
    else distPts = 4;
  }
  factors.distance = distPts;
  score += factors.distance;

  const allocRatio = gateResult.potentialAlloc / gateResult.demandRem;
  let fitPts = 4;
  if (allocRatio >= 0.8) fitPts = 15;
  else if (allocRatio >= 0.5) fitPts = 11;
  else if (allocRatio >= 0.2) fitPts = 7;
  factors.quantityFit = fitPts;
  score += factors.quantityFit;

  let capPts = 6;
  if (demandOrg?.verified) capPts += 4;
  factors.capacity = capPts;
  score += factors.capacity;

  const recentMatches = db.prepare(`
    SELECT COUNT(*) as count FROM matches
    WHERE demand_org_id = ? AND matched_at >= datetime('now', '-24 hours')
  `).get(demand.demand_org_id)?.count || 0;
  let fairnessPts = 10;
  if (recentMatches === 1) fairnessPts = 7;
  else if (recentMatches === 2) fairnessPts = 4;
  else if (recentMatches >= 3) fairnessPts = 1;
  factors.fairness = fairnessPts;
  score += factors.fairness;

  const totalScore = Math.min(100, Math.round(score));
  const distText = gateResult.distanceKm !== null ? `${gateResult.distanceKm.toFixed(1)} km away` : 'location within service area';
  const routeVia = gateResult.routeProvider && gateResult.routeProvider !== 'haversine' ? ` via ${gateResult.routeProvider}` : '';
  const hoursMargin = Math.max(0.1, Math.round(safeHours * 10) / 10);
  const percentCovered = Math.round((gateResult.potentialAlloc / gateResult.demandRem) * 100);
  const explanation = `Compatible ${surplus.food_type.replace('_', ' ')}, ${distText}${routeVia}. Covers ${gateResult.potentialAlloc} of ${gateResult.demandRem} requested ${demand.quantity_unit} (${percentCovered}% coverage). Urgency: ${demand.urgency}, safe arrival with ${hoursMargin}h freshness buffer.`;

  return { score: totalScore, factors, explanation, allocQty: gateResult.potentialAlloc, demandRem: gateResult.demandRem, surplusRem: gateResult.surplusRem, distanceKm: gateResult.distanceKm, durationMinutes: gateResult.transitMinutes, routeProvider: gateResult.routeProvider || 'haversine' };
}

// ── 7. LIFECYCLE ROUTING HELPERS ──────────────────────────────────────────────

/**
 * Step 1/7: Routes a surplus post to biogas. Creates audit record and notifies donor.
 * Routes only when a specific active, eligible biogas facility can be selected.
 * @param {Object} surplus
 * @param {string} reason
 * @param {Map}    [precomputedBiogasRoutes]  Map(facilityId → routeResult) from precomputeRoutesToBiogas()
 */
function routeToBiogas(surplus, reason, precomputedBiogasRoutes) {
  const qty = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);
  const facilityResult = routeToBiogasFacility(surplus, reason, qty, precomputedBiogasRoutes);
  if (!facilityResult.facilityId) {
    const reviewReason = `Biogas routing unavailable: ${reason}; no active eligible biogas centre could be selected`;
    routeToReview(surplus, reviewReason);
    return { surplusId: surplus.id, destination: 'review', facilityId: null, reason: reviewReason };
  }

  db.prepare(`
    UPDATE surplus_posts
    SET status = 'biogas_pending', biogas_reason = ?, remaining_quantity = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, surplus.id);

  const destLabel = facilityResult.destinationName;
  const etaLabel = facilityResult.routeDurMin
    ? ` (~${Math.round(facilityResult.routeDurMin)} min, ${facilityResult.routeDistKm?.toFixed(1)} km via ${facilityResult.routeProv})`
    : '';

  createAlert(surplus.donor_org_id, null, 'biogas', '♻️ Surplus Routed to Biogas',
    `A biogas delivery request for "${surplus.food_name}" (${qty} ${surplus.quantity_unit}) was sent to ${destLabel}${etaLabel}. It is awaiting facility acceptance. Reason: ${reason}`);

  console.log(`[Matching] Biogas route: surplus ${surplus.id} → ${destLabel} — ${reason}`);
  return { surplusId: surplus.id, destination: 'biogas', facilityId: facilityResult.facilityId, destinationName: destLabel, reason };
}

/** Route expired food-bank stock to a specific eligible biogas facility. */
function routeInventoryToBiogas(item, reason, precomputedBiogasRoutes) {
  const quantity = Number(item.quantity_remaining || 0);
  if (quantity <= 0.001) return null;
  const inventorySource = {
    id: `inventory:${item.id}`,
    sourceType: 'food_bank_inventory',
    sourceInventoryId: item.id,
    donor_org_id: item.org_id,
    food_name: item.food_name,
    food_type: item.food_type || '',
    quantity,
    remaining_quantity: quantity,
    quantity_unit: item.quantity_unit || 'kg'
  };
  const facilityResult = routeToBiogasFacility(inventorySource, reason, quantity, precomputedBiogasRoutes);
  if (!facilityResult.facilityId) {
    const reviewReason = `${reason}; no active eligible biogas centre could be selected`;
    db.prepare(`UPDATE food_bank_inventory SET biogas_status = 'review_required', biogas_reason = ? WHERE id = ?`)
      .run(reviewReason, item.id);
    createAlert(item.org_id, null, 'review', 'Expired food needs biogas routing review',
      `Expired inventory "${item.food_name}" (${quantity} ${inventorySource.quantity_unit}) has no available eligible biogas destination.`);
    return { inventoryId: item.id, destination: 'review', facilityId: null, reason: reviewReason };
  }

  db.prepare(`UPDATE food_bank_inventory SET quantity_remaining = 0, biogas_status = 'pending', biogas_reason = ? WHERE id = ?`)
    .run(reason, item.id);
  const etaLabel = facilityResult.routeDurMin
    ? ` (~${Math.round(facilityResult.routeDurMin)} min, ${facilityResult.routeDistKm?.toFixed(1)} km via ${facilityResult.routeProv})`
    : '';
  createAlert(item.org_id, null, 'biogas', 'Expired stock routed to biogas',
    `A biogas delivery request for "${item.food_name}" (${quantity} ${inventorySource.quantity_unit}) was sent to ${facilityResult.destinationName}${etaLabel}. It is awaiting facility acceptance.`);
  return { inventoryId: item.id, destination: 'biogas', facilityId: facilityResult.facilityId, reason };
}

/**
 * Finds the best biogas facility for the surplus and inserts a biogas_routes record.
 * Uses pre-computed road routes when available (same routing service as demand matching).
 * Picks nearest verified+active facility by road distance whose accepted_waste_types covers
 * the food type and whose daily capacity (in kg) has not been exceeded today.
 * Falls back to haversine distance if no route result is available for a candidate.
 * Returns no destination if no facility qualifies; callers must escalate to review.
 * @param {Object}  surplus
 * @param {string}  reason
 * @param {number}  [qty]
 * @param {Map}     [precomputedBiogasRoutes]  Map(facilityId → routeResult)
 */
function routeToBiogasFacility(surplus, reason, qty, precomputedBiogasRoutes) {
  const actualQty = qty != null ? qty : (surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity));
  const donorOrg = db.prepare('SELECT location_lat, location_lng FROM organizations WHERE id = ?').get(surplus.donor_org_id);

  const facilities = db.prepare(`
    SELECT * FROM biogas_facilities WHERE status = 'active' AND verified = 1 AND COALESCE(is_available, 1) = 1
  `).all();

  const rejectionLog = [];
  const rejectedFacilityIds = new Set(db.prepare(`
    SELECT biogas_facility_id FROM biogas_routes WHERE surplus_id = ? AND status = 'rejected' AND biogas_facility_id IS NOT NULL
  `).all(surplus.id).map(row => row.biogas_facility_id));
  let chosen = null;
  let chosenDist = Infinity;
  let chosenRouteResult = null;

  for (const fac of facilities) {
    if (rejectedFacilityIds.has(fac.id)) continue;
    // Check accepted_waste_types — empty array means accepts all
    let accepted;
    try { accepted = JSON.parse(fac.accepted_waste_types || '[]'); } catch { accepted = []; }

    if (accepted.length > 0) {
      const ft = (surplus.food_type || '').toLowerCase();
      const accepts = accepted.some(t => {
        const tn = t.toLowerCase();
        return tn === ft || tn === 'all_food_waste' || ft.includes(tn) || tn.includes(ft);
      });
      if (!accepts) {
        rejectionLog.push({ facility: fac.name, reason: `Food type "${surplus.food_type}" not in accepted waste types: [${accepted.join(', ')}]` });
        continue;
      }
    }

    // Check daily intake capacity — convert surplus qty to kg if needed before comparing
    if (fac.max_daily_intake_kg > 0) {
      const todayRoutes = db.prepare(`
        SELECT quantity, quantity_unit, food_type
        FROM biogas_routes
        WHERE biogas_facility_id = ? AND date(created_at) = date('now') AND status != 'rejected'
      `).all(fac.id);
      const usedKg = todayRoutes.reduce((sum, route) => {
        const converted = convertQuantity(Number(route.quantity) || 0, route.quantity_unit || 'kg', 'kg', route.food_type);
        return sum + (converted.success ? converted.convertedQty : (Number(route.quantity) || 0));
      }, 0);
      // Convert actualQty to kg equivalent for capacity check
      const qtyKg = (() => {
        const unit = (surplus.quantity_unit || 'kg').toLowerCase();
        if (unit === 'servings' || unit === 'serving' || unit === 'portions') return actualQty * 0.4;
        if (unit === 'liters' || unit === 'litres' || unit === 'liter') return actualQty;
        if (unit === 'g' || unit === 'gram' || unit === 'grams') return actualQty / 1000;
        return actualQty; // kg
      })();
      if ((usedKg + qtyKg) > fac.max_daily_intake_kg) {
        rejectionLog.push({ facility: fac.name, reason: `Daily capacity exceeded: ${usedKg + qtyKg} kg > ${fac.max_daily_intake_kg} kg/day` });
        continue;
      }
    }

    // Use pre-computed road distance if available; fall back to haversine
    let dist = Infinity;
    let routeResult = null;
    const precomputed = precomputedBiogasRoutes && precomputedBiogasRoutes.get(fac.id);
    if (precomputed && precomputed.distanceKm != null) {
      dist = precomputed.distanceKm;
      routeResult = precomputed;
    } else if (donorOrg?.location_lat && fac.location_lat) {
      const hDist = haversineKm(donorOrg.location_lat, donorOrg.location_lng, fac.location_lat, fac.location_lng);
      dist = hDist != null ? hDist : Infinity;
      routeResult = { distanceKm: dist, durationMinutes: (dist / 25) * 60 + 40, provider: 'haversine (approx)' };
    }

    if (dist < chosenDist) {
      chosenDist = dist;
      chosen = fac;
      chosenRouteResult = routeResult;
    }
  }

  if (!chosen) return { facilityId: null, destinationName: null, rejectionLog };

  const destinationName = chosen.name;
  const facilityId = chosen.id;
  const routeDistKm = chosenRouteResult?.distanceKm ?? null;
  const routeDurMin = chosenRouteResult?.durationMinutes ?? null;
  const routeProv = chosenRouteResult?.provider ?? 'haversine';

  const auditJson = rejectionLog.length
    ? JSON.stringify({ rejections: rejectionLog, selected: destinationName, routeDistKm, routeDurMin, routeProv })
    : null;

  db.prepare(`
    INSERT INTO biogas_routes (id, surplus_id, source_type, source_inventory_id, donor_org_id, food_name, food_type, quantity, quantity_unit,
      reason, destination_name, biogas_facility_id, route_distance_km, route_duration_minutes, route_provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), surplus.id, surplus.sourceType || 'surplus', surplus.sourceInventoryId || null, surplus.donor_org_id, surplus.food_name, surplus.food_type,
         actualQty, surplus.quantity_unit, reason, destinationName, facilityId,
         routeDistKm, routeDurMin, routeProv);

  if (rejectionLog.length) {
    console.log(`[Matching] Biogas facility selection: ${rejectionLog.length} rejected, chose "${destinationName}"${routeDistKm ? ` (${routeDistKm.toFixed(1)} km road)` : ''}`);
  }

  return { facilityId, destinationName, routeDistKm, routeDurMin, routeProv, audit: auditJson };
}

/**
 * Step 7: Flags a surplus post for manual operator review.
 */
function routeToReview(surplus, reason) {
  db.prepare(`
    UPDATE surplus_posts
    SET status = 'review_required', review_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, surplus.id);

  createAlert(null, null, 'review', '🔍 Surplus Requires Manual Review',
    `Surplus "${surplus.food_name}" from donor ${surplus.donor_org_id} needs operator attention. Reason: ${reason}`);

  createAlert(surplus.donor_org_id, null, 'review', '⏳ Surplus Under Review',
    `Your surplus "${surplus.food_name}" is being reviewed by our coordination team. Reason: ${reason}`);

  console.log(`[Matching] Review required: surplus ${surplus.id} — ${reason}`);
  return { surplusId: surplus.id, destination: 'review', reason };
}

/**
 * Step 2: Pre-check whether surplus can be delivered to anyone in time.
 * Returns { feasible, missingData, reason }
 */
function estimateDeliveryFeasibility(surplus, donorOrg) {
  const now = Date.now();
  const expiryMs = parseSqliteDate(surplus.remaining_usable_time);

  if (!expiryMs || isNaN(expiryMs) || expiryMs <= now) {
    return { feasible: false, missingData: false, reason: 'Surplus has already expired or expiry time is invalid' };
  }

  // Missing or uncertain location data -> flowchart branch C: Missing or uncertain data -> REVIEW
  if (!donorOrg?.location_lat || !donorOrg?.location_lng ||
      (donorOrg.location_lat === 0 && donorOrg.location_lng === 0)) {
    return {
      feasible: false,
      missingData: true,
      reason: 'Donor location is missing or uncertain — delivery feasibility cannot be verified without manual operator review'
    };
  }

  // Do not use a global minimum-transit cutoff here. Each demand and food-bank
  // candidate is checked against its own route ETA and 15-minute freshness buffer.
  return { feasible: true, missingData: false, reason: null };
}

/**
 * Step 6: Food bank fallback — validates food type, cold storage, capacity AND delivery timing.
 * Returns a match record object on success, null if no suitable food bank found.
 * @param {Object} surplus
 * @param {Object} donorOrg
 * @param {Map} [precomputedRoutes] - optional Map(orgId → routeResult)
 */
function tryFoodBankFallback(surplus, donorOrg, precomputedRoutes) {
  const now = Date.now();
  const expiryMs = parseSqliteDate(surplus.remaining_usable_time);
  let remainingQty = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);
  if (remainingQty <= 0.001) return null;

  const foodBankCandidates = db.prepare(`
    SELECT o.*, dp.food_requirements, dp.dietary_restrictions, dp.receiving_capacity, dp.receiving_capacity_kg,
           dp.storage_capacity, dp.serving_capacity
    FROM organizations o
    JOIN demand_org_profiles dp ON o.id = dp.org_id
    WHERE o.status = 'active' AND o.verified = 1 AND o.type LIKE '%food_bank%'
  `).all();

  if (!foodBankCandidates.length) return null;

  const eligibleBanks = [];

  for (const fb of foodBankCandidates) {
    // A declined fallback is a final no from this bank for this surplus.
    const previouslyDeclined = db.prepare(`
      SELECT 1 FROM matches
      WHERE source_type = 'surplus' AND surplus_id = ? AND demand_org_id = ? AND status = 'declined'
      LIMIT 1
    `).get(surplus.id, fb.id);
    if (previouslyDeclined) continue;

    let dist = null;
    let routeDuration = null;
    let routeProv = 'haversine';

    // Use pre-computed road distance if available
    const precomputed = precomputedRoutes && precomputedRoutes.get(fb.id);
    if (precomputed && precomputed.distanceKm != null) {
      dist = precomputed.distanceKm;
      routeDuration = precomputed.durationMinutes;
      routeProv = precomputed.provider || 'osrm';
    } else if (donorOrg?.location_lat && fb.location_lat) {
      dist = haversineDistance(donorOrg.location_lat, donorOrg.location_lng, fb.location_lat, fb.location_lng);
    }

    if (dist !== null && dist > MAX_MATCH_DISTANCE_KM) continue;

    // Delivery timing: food bank must be reachable before expiry with 15 min buffer
    if (expiryMs && !isNaN(expiryMs)) {
      const transitMins = routeDuration != null ? Math.round(routeDuration) : (dist != null ? Math.round(40 + (dist / 25) * 60) : 45);
      const estimatedArrival = now + transitMins * 60 * 1000;
      if (estimatedArrival + 15 * 60 * 1000 > expiryMs) continue;
    }

    // Food type compatibility — food bank profile constraints must be satisfied
    const profileFoodReqs = parseTags(fb.food_requirements);
    if (!isFoodAcceptedByProfile(surplus.food_type, surplus.food_name, profileFoodReqs)) {
      continue;
    }
    if (!checkDietarySafety(surplus.dietary_tags, [], fb.dietary_restrictions).pass) continue;

    // Cold storage check for perishables (require positive evidence)
    const isPerishable = findCluster(surplus.food_type) === 'dairy' ||
      findCluster(surplus.food_type) === 'cooked_meals';
    const storageStr = normalizeString(fb.storage_capacity || '');
    if (isPerishable) {
      const hasCold = /(refrigerat|cold storage|freezer|chilled|cold chain)/i.test(storageStr);
      if (!hasCold) continue;
    }

    // A bank may accept part of the remaining surplus; the rest can be offered
    // to another eligible bank instead of rejecting this bank outright.
    // Food banks must declare a daily receiving limit. Count pending offers as
    // reserved capacity, along with today's accepted/completed allocations.
    // Unknown capacity is not treated as unlimited capacity.
    let capacityInSurplusUnit = 0;
    const capacityKg = Number(fb.receiving_capacity_kg);
    if (Number.isFinite(capacityKg) && capacityKg > 0) {
      // receiving_capacity_kg is a daily intake limit. Reserve capacity for
      // today's pending, accepted, and completed offers so simultaneous
      // surplus posts cannot overbook a food bank before it responds.
      const todaysMatches = db.prepare(`
        SELECT m.allocated_quantity, m.allocated_unit, s.food_type
        FROM matches m
        LEFT JOIN surplus_posts s ON s.id = m.surplus_id
        WHERE m.demand_org_id = ?
          AND m.status IN ('pending', 'confirmed', 'completed')
          AND date(m.matched_at) = date('now')
      `).all(fb.id);
      const usedKg = todaysMatches.reduce((total, match) => {
        const converted = convertQuantity(
          Number(match.allocated_quantity) || 0,
          match.allocated_unit || 'kg',
          'kg',
          match.food_type || surplus.food_type
        );
        return total + (converted.success ? converted.convertedQty : (Number(match.allocated_quantity) || 0));
      }, 0);
      const capacityLeftKg = Math.max(0, capacityKg - usedKg);
      const convertedCapacity = convertQuantity(capacityLeftKg, 'kg', surplus.quantity_unit, surplus.food_type);
      if (convertedCapacity.success) capacityInSurplusUnit = convertedCapacity.convertedQty;
    }
    if (capacityInSurplusUnit <= 0.001) continue;

    if (dist == null || dist > MAX_MATCH_DISTANCE_KM) continue;
    const routeResult = precomputed?.distanceKm != null
      ? precomputed
      : { distanceKm: dist, durationMinutes: routeDuration || (40 + (dist / 25) * 60), provider: routeProv };
    const transitMinutes = Number(routeResult.durationMinutes) || Math.round(40 + (dist / 25) * 60);
    const allocQty = Math.min(remainingQty, capacityInSurplusUnit);
    const demandForRanking = {
      id: `food-bank-fallback:${fb.id}`,
      demand_org_id: fb.id,
      urgency: 'regular',
      required_by: null,
      quantity_unit: surplus.quantity_unit || 'kg'
    };
    const ranking = rankCandidate({
      distanceKm: dist,
      transitMinutes,
      routeProvider: routeResult.provider || routeProv,
      surplusExpiry: expiryMs,
      estimatedArrival: now + transitMinutes * 60000,
      potentialAlloc: allocQty,
      demandRem: Math.max(remainingQty, 0.001),
      surplusRem: remainingQty
    }, surplus, demandForRanking, fb);
    eligibleBanks.push({ bank: fb, distance: dist, routeResult, capacityInSurplusUnit, ranking });
  }

  // Same explainable score as direct demand matching: urgency/freshness,
  // route distance, capacity fit and fairness. The route distance is a major
  // component and breaks ties by the nearest bank.
  eligibleBanks.sort((a, b) => b.ranking.score - a.ranking.score || a.distance - b.distance);
  const allocations = [];
  for (const candidate of eligibleBanks) {
    if (remainingQty <= 0.001) break;
    const allocatedQty = Math.min(remainingQty, candidate.capacityInSurplusUnit);
    if (allocatedQty <= 0.001) continue;

    const matchId = uuidv4();
    const distText = candidate.distance !== Infinity ? `${candidate.distance.toFixed(1)} km` : 'distance unavailable';
    const explanation = `No compatible direct demand used this quantity. Allocated ${allocatedQty} ${surplus.quantity_unit} to food bank "${candidate.bank.name}" (${distText}) for community distribution. ${candidate.ranking.explanation}`;

    db.prepare(`
      INSERT INTO matches (id, surplus_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes,
        route_distance_km, route_duration_minutes, route_provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'fallback_food_bank', ?, ?, ?)
    `).run(
      matchId, surplus.id, candidate.bank.id, candidate.ranking.score, allocatedQty, surplus.quantity_unit, explanation,
      candidate.routeResult?.distanceKm ?? null,
      candidate.routeResult?.durationMinutes ?? null,
      candidate.routeResult?.provider ?? 'haversine'
    );

    allocations.push({ matchId, foodBankId: candidate.bank.id, foodBankName: candidate.bank.name, quantity: allocatedQty, explanation });
    remainingQty = Math.max(0, remainingQty - allocatedQty);
    createAlert(surplus.donor_org_id, null, 'fallback', '🏦 Surplus Routed to Food Bank',
      `${allocatedQty} ${surplus.quantity_unit} of "${surplus.food_name}" has been allocated to ${candidate.bank.name}.`);
    createAlert(candidate.bank.id, null, 'incoming', '📦 Incoming Food Bank Delivery',
      `${allocatedQty} ${surplus.quantity_unit} of "${surplus.food_name}" from donor has been allocated to your food bank.`);
  }

  if (!allocations.length) return null;

  db.prepare(`
    UPDATE surplus_posts SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(Math.round(remainingQty * 100) / 100, remainingQty <= 0.001 ? 'matched' : 'partially_matched', surplus.id);

  return {
    fallback: true,
    allocations,
    remainingQuantity: Math.round(remainingQty * 100) / 100,
    foodBankId: allocations[0].foodBankId,
    foodBankName: allocations[0].foodBankName
  };
}

// ── 8. UNIFIED TRANSACTIONAL MATCHER ──────────────────────────────────────────

/**
 * Shared matcher called by BOTH donor surplus posts and recipient demand registrations.
 * Full lifecycle per flowchart:
 *   1. Safety gate → biogas if expired or unsafe
 *   2. Delivery feasibility → biogas/review if cannot deliver
 *   3. Demand matching loop with quantity allocation
 *   4. Food bank fallback for leftover surplus
 *   5. Operator review or biogas for confirmed-unallocatable remainder
 *   6. Notifications at every decision point
 */
function runUnifiedMatching({ surplusId, demandId, routeResults, biogasRouteResults } = {}) {
  const matchesCreated = [];

  const executeTx = db.transaction(() => {
    // ── PATH A: Donor posted surplus (or match specific surplus) ─────────────
    if (surplusId) {
      const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
      if (!surplus) return;

      // STEP 1 — Safety gate: explicitly unsafe → biogas immediately
      if (surplus.unsafe === 1) {
        routeToBiogas(surplus, 'Food was marked unsafe by the donor or platform', biogasRouteResults);
        return;
      }
      // STEP 1 — Expired → biogas immediately
      const now = Date.now();
      const expiryMs = parseSqliteDate(surplus.remaining_usable_time);
      if (!expiryMs || isNaN(expiryMs) || expiryMs <= now) {
        routeToBiogas(surplus, 'Surplus food has expired and cannot be offered for consumption', biogasRouteResults);
        return;
      }

      if (!['available', 'partially_matched'].includes(surplus.status)) return;

      let currentSurplusRem = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);
      if (currentSurplusRem <= 0.001) return;

      const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(surplus.donor_org_id);

      // STEP 2 — Delivery feasibility pre-check
      const feasibility = estimateDeliveryFeasibility(surplus, donorOrg);
      if (!feasibility.feasible) {
        if (feasibility.missingData) {
          routeToReview(surplus, feasibility.reason);
        } else {
          routeToBiogas(surplus, feasibility.reason, biogasRouteResults);
        }
        return;
      }
      // Missing data but still feasible → flag for review but continue matching
      // (per-demand gates in checkCompatibility handle per-route timing)

      // STEP 3 — Find open / partially fulfilled demands from active, verified orgs
      const demands = db.prepare(`
        SELECT dr.*, o.location_lat, o.location_lng, o.status as org_status, o.name as org_name
        FROM demand_registrations dr
        JOIN organizations o ON dr.demand_org_id = o.id
        WHERE dr.status IN ('open', 'partially_fulfilled')
          AND o.status = 'active'
          AND o.verified = 1
          AND COALESCE(dr.remaining_quantity, dr.quantity_needed) > 0
          AND NOT EXISTS (
            SELECT 1 FROM matches rejected
            WHERE rejected.source_type = 'surplus' AND rejected.surplus_id = ?
              AND rejected.demand_id = dr.id AND rejected.status = 'declined'
          )
        ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 WHEN 'regular' THEN 3 WHEN 'planned' THEN 4 END
      `).all(surplus.id);

      const candidates = [];
      for (const dem of demands) {
        const demandOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(dem.demand_org_id);
        const demandProfile = db.prepare('SELECT * FROM demand_org_profiles WHERE org_id = ?').get(dem.demand_org_id);
        const routeResult = routeResults && routeResults.get(dem.demand_org_id);
        const gate = checkCompatibility({ ...surplus, remaining_quantity: currentSurplusRem }, dem, donorOrg, demandOrg, demandProfile, routeResult);
        if (gate.pass) {
          const ranking = rankCandidate(gate, surplus, dem, demandOrg);
          candidates.push({ demand: dem, demandOrg, ranking });
        }
      }

      // STEP 4 — Rank eligible demands
      candidates.sort((a, b) => b.ranking.score - a.ranking.score ||
        (a.ranking.durationMinutes ?? Infinity) - (b.ranking.durationMinutes ?? Infinity) ||
        (a.ranking.distanceKm ?? Infinity) - (b.ranking.distanceKm ?? Infinity));

      // STEP 5 — Allocate to ranked demands while surplus remains
      for (const cand of candidates) {
        if (currentSurplusRem <= 0.001) break;

        const dem = cand.demand;
        const freshDem = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(dem.id);
        let freshDemRem = freshDem.remaining_quantity != null ? Number(freshDem.remaining_quantity) : Number(freshDem.quantity_needed);
        if (freshDemRem <= 0.001) continue;

        const conv = convertQuantity(currentSurplusRem, surplus.quantity_unit, freshDem.quantity_unit, surplus.food_type);
        if (!conv.success) continue;

        const allocInDemandUnit = Math.min(conv.convertedQty, freshDemRem);
        if (allocInDemandUnit <= 0.001) continue;

        const convBack = convertQuantity(allocInDemandUnit, freshDem.quantity_unit, surplus.quantity_unit, surplus.food_type);
        const allocInSurplusUnit = convBack.success ? convBack.convertedQty : allocInDemandUnit;

        currentSurplusRem = Math.max(0, currentSurplusRem - allocInSurplusUnit);
        const newSurplusStatus = currentSurplusRem <= 0.001 ? 'matched' : 'available';

        db.prepare(`
          UPDATE surplus_posts SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(Math.round(currentSurplusRem * 100) / 100, newSurplusStatus, surplus.id);

        const newDemRem = Math.max(0, freshDemRem - allocInDemandUnit);
        const newDemStatus = newDemRem <= 0.001 ? 'fulfilled' : 'partially_fulfilled';

        db.prepare(`
          UPDATE demand_registrations SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(Math.round(newDemRem * 100) / 100, newDemStatus, dem.id);

        const matchId = uuidv4();
        db.prepare(`
          INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes,
            route_distance_km, route_duration_minutes, route_provider)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(matchId, surplus.id, dem.id, dem.demand_org_id,
          cand.ranking.score, allocInDemandUnit, freshDem.quantity_unit,
          cand.ranking.explanation, cand.ranking.explanation,
          cand.ranking.distanceKm ?? null,
          cand.ranking.durationMinutes ?? null,
          cand.ranking.routeProvider ?? 'haversine');

        matchesCreated.push({
          matchId, surplusId: surplus.id, demandId: dem.id, demandOrgId: dem.demand_org_id,
          allocatedQuantity: allocInDemandUnit, allocatedUnit: freshDem.quantity_unit,
          score: cand.ranking.score, explanation: cand.ranking.explanation
        });

        // STEP 8 — Notify both parties
        createAlert(dem.demand_org_id, null, 'match', '🍱 Food Match Found!',
          `Matched ${allocInDemandUnit} ${freshDem.quantity_unit} of ${surplus.food_name}. ${cand.ranking.explanation}`);
        createAlert(surplus.donor_org_id, null, 'match', '✅ Surplus Matched',
          `Allocated ${allocInDemandUnit} ${freshDem.quantity_unit} of ${surplus.food_name} to ${cand.demandOrg.name}.`);
      }

      // STEP 6 — Food bank fallback for any remaining quantity
      if (currentSurplusRem > 0.001) {
        const fallback = tryFoodBankFallback({ ...surplus, remaining_quantity: currentSurplusRem }, donorOrg, routeResults);
        if (fallback) {
          matchesCreated.push(fallback);
          currentSurplusRem = fallback.remainingQuantity;
        }
      }

      // STEP 7 — No destination confirmed: review or biogas
      if (currentSurplusRem > 0.001) {
        const freshSurplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplus.id);
        const freshRem = freshSurplus.remaining_quantity != null ? Number(freshSurplus.remaining_quantity) : Number(freshSurplus.quantity);
        if (freshRem > 0.001) {
          const timeLeftMs = expiryMs ? expiryMs - Date.now() : 0;
          if (timeLeftMs < 2 * 60 * 60 * 1000) {
            routeToBiogas(freshSurplus,
              `No compatible demand or food bank found; food expires in ${Math.round(timeLeftMs / 60000)} minutes`,
              biogasRouteResults);
          } else {
            routeToReview(freshSurplus,
              'No compatible direct demand or food bank could be confirmed. Operator review required to determine best destination.');
          }
        }
      }
    }

    // ── PATH B: Recipient posted demand (or match specific demand) ───────────
    else if (demandId) {
      const demand = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(demandId);
      if (!demand || !['open', 'partially_fulfilled'].includes(demand.status)) return;

      let currentDemandRem = demand.remaining_quantity != null ? Number(demand.remaining_quantity) : Number(demand.quantity_needed);
      if (currentDemandRem <= 0.001) return;

      const demandOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(demand.demand_org_id);
      const demandProfile = db.prepare('SELECT * FROM demand_org_profiles WHERE org_id = ?').get(demand.demand_org_id);

      // Find active surplus from verified donors and all usable food-bank stock.
      // Inventory rows must have an explicit, future expiry date; unknown expiry
      // is not treated as safe/in-date. Inventory quantity is reserved by
      // decrementing quantity_remaining in the same transaction as the match.
      const surplusPosts = db.prepare(`
        SELECT sp.*, o.location_lat, o.location_lng, o.status as org_status, o.name as org_name
        FROM surplus_posts sp
        JOIN organizations o ON sp.donor_org_id = o.id
        WHERE sp.status IN ('available', 'partially_matched', 'review_required')
          AND (sp.status != 'review_required' OR COALESCE(sp.review_reason, '') NOT LIKE 'Biogas routing unavailable:%')
          AND o.status = 'active'
          AND o.verified = 1
          AND COALESCE(sp.remaining_quantity, sp.quantity) > 0
          AND NOT EXISTS (
            SELECT 1 FROM matches rejected
            WHERE rejected.source_type = 'surplus' AND rejected.surplus_id = sp.id
              AND rejected.demand_id = ? AND rejected.status = 'declined'
          )
        ORDER BY sp.remaining_usable_time ASC
      `).all(demand.id);

      const inventoryItems = db.prepare(`
        SELECT i.*, o.location_lat, o.location_lng, o.status AS org_status,
               o.name AS org_name, o.verified AS org_verified
        FROM food_bank_inventory i
        JOIN organizations o ON o.id = i.org_id
        WHERE o.type LIKE '%food_bank%'
          AND o.status = 'active' AND o.verified = 1
          AND i.org_id != ?
          AND COALESCE(i.quantity_remaining, 0) > 0
          AND COALESCE(i.biogas_status, 'available') = 'available'
          AND i.expiry_date IS NOT NULL
          AND date(i.expiry_date) >= date('now')
          AND NOT EXISTS (
            SELECT 1 FROM matches rejected
            WHERE rejected.source_type = 'food_bank_inventory' AND rejected.source_inventory_id = i.id
              AND rejected.demand_id = ? AND rejected.status = 'declined'
          )
        ORDER BY i.expiry_date ASC
      `).all(demand.demand_org_id, demand.id);

      const candidates = [];
      for (const sp of surplusPosts) {
        const now = Date.now();
        const spExpiry = parseSqliteDate(sp.remaining_usable_time);

        // Lifecycle gap fix: expired surplus encountered during demand matching routes to biogas
        if (!spExpiry || isNaN(spExpiry) || spExpiry <= now) {
          routeToBiogas(sp, 'Surplus food expired prior to allocation', biogasRouteResults);
          continue;
        }

        // Safety gate: explicitly unsafe surplus routes to biogas
        if (sp.unsafe === 1) {
          routeToBiogas(sp, 'Food was marked unsafe by the donor or platform', biogasRouteResults);
          continue;
        }

        const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(sp.donor_org_id);

        // Missing location or delivery feasibility check (Flowchart Branch C)
        const feasibility = estimateDeliveryFeasibility(sp, donorOrg);
        if (!feasibility.feasible) {
          if (feasibility.missingData) {
            routeToReview(sp, feasibility.reason);
          } else {
            routeToBiogas(sp, feasibility.reason, biogasRouteResults);
          }
          continue;
        }

        const routeResult = routeResults && routeResults.get(sp.donor_org_id);
        const gate = checkCompatibility(sp, { ...demand, remaining_quantity: currentDemandRem }, donorOrg, demandOrg, demandProfile, routeResult);
        if (gate.pass) {
          const ranking = rankCandidate(gate, sp, demand, demandOrg);
          candidates.push({ surplus: sp, donorOrg, ranking });
        }
      }

      for (const item of inventoryItems) {
        const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(item.org_id);
        if (!donorOrg) continue;
        // Date-only inventory entries remain valid through that day in India.
        // Timestamp entries preserve their exact safe-until instant.
        const expiryValue = String(item.expiry_date).trim();
        const inventoryExpiry = /^\d{4}-\d{2}-\d{2}$/.test(expiryValue)
          ? new Date(`${expiryValue}T23:59:59.999+05:30`).toISOString()
          : new Date(parseSqliteDate(expiryValue)).toISOString();
        const inventorySupply = {
          id: `inventory:${item.id}`,
          donor_org_id: item.org_id,
          food_name: item.food_name,
          food_type: item.food_type || '',
          dietary_tags: item.dietary_tags || '[]',
          quantity: Number(item.quantity_remaining),
          remaining_quantity: Number(item.quantity_remaining),
          quantity_unit: item.quantity_unit || 'kg',
          remaining_usable_time: inventoryExpiry,
          unsafe: 0,
          sourceType: 'food_bank_inventory',
          sourceInventoryId: item.id
        };
        const routeResult = routeResults && routeResults.get(item.org_id);
        const gate = checkCompatibility(inventorySupply, { ...demand, remaining_quantity: currentDemandRem }, donorOrg, demandOrg, demandProfile, routeResult);
        if (gate.pass) {
          const ranking = rankCandidate(gate, inventorySupply, demand, demandOrg);
          candidates.push({ surplus: inventorySupply, donorOrg, ranking, sourceType: 'food_bank_inventory', inventory: item });
        }
      }

      candidates.sort((a, b) => b.ranking.score - a.ranking.score ||
        (a.ranking.durationMinutes ?? Infinity) - (b.ranking.durationMinutes ?? Infinity) ||
        (a.ranking.distanceKm ?? Infinity) - (b.ranking.distanceKm ?? Infinity));

      for (const cand of candidates) {
        if (currentDemandRem <= 0.001) break;

        const sp = cand.surplus;
        const isInventory = cand.sourceType === 'food_bank_inventory';
        const freshSp = isInventory
          ? db.prepare('SELECT * FROM food_bank_inventory WHERE id = ? AND org_id = ?').get(cand.inventory.id, cand.inventory.org_id)
          : db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(sp.id);
        if (!freshSp) continue;
        let freshSurplusRem = isInventory
          ? Number(freshSp.quantity_remaining || 0)
          : (freshSp.remaining_quantity != null ? Number(freshSp.remaining_quantity) : Number(freshSp.quantity));
        if (freshSurplusRem <= 0.001) continue;

        const conv = convertQuantity(freshSurplusRem, sp.quantity_unit, demand.quantity_unit, sp.food_type);
        if (!conv.success) continue;

        const allocInDemandUnit = Math.min(conv.convertedQty, currentDemandRem);
        if (allocInDemandUnit <= 0.001) continue;

        const convBack = convertQuantity(allocInDemandUnit, demand.quantity_unit, sp.quantity_unit, sp.food_type);
        const allocInSurplusUnit = convBack.success ? convBack.convertedQty : allocInDemandUnit;

        const newSurplusRem = Math.max(0, freshSurplusRem - allocInSurplusUnit);
        if (isInventory) {
          db.prepare(`UPDATE food_bank_inventory SET quantity_remaining = ? WHERE id = ? AND org_id = ?`)
            .run(Math.round(newSurplusRem * 100) / 100, cand.inventory.id, cand.inventory.org_id);
        } else {
          const newSurplusStatus = newSurplusRem <= 0.001 ? 'matched' : 'partially_matched';
          db.prepare(`
            UPDATE surplus_posts SET remaining_quantity = ?, status = ?, review_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          `).run(Math.round(newSurplusRem * 100) / 100, newSurplusStatus, sp.id);
        }

        currentDemandRem = Math.max(0, currentDemandRem - allocInDemandUnit);
        const newDemandStatus = currentDemandRem <= 0.001 ? 'fulfilled' : 'partially_fulfilled';

        db.prepare(`
          UPDATE demand_registrations SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(Math.round(currentDemandRem * 100) / 100, newDemandStatus, demand.id);

        const matchId = uuidv4();
        db.prepare(`
          INSERT INTO matches (id, surplus_id, source_type, source_inventory_id, demand_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes,
            route_distance_km, route_duration_minutes, route_provider)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(matchId, isInventory ? `inventory:${cand.inventory.id}` : sp.id,
          isInventory ? 'food_bank_inventory' : 'surplus', isInventory ? cand.inventory.id : null,
          demand.id, demand.demand_org_id,
          cand.ranking.score, allocInDemandUnit, demand.quantity_unit,
          cand.ranking.explanation, cand.ranking.explanation,
          cand.ranking.distanceKm ?? null,
          cand.ranking.durationMinutes ?? null,
          cand.ranking.routeProvider ?? 'haversine');

        matchesCreated.push({
          matchId, surplusId: sp.id, demandId: demand.id, demandOrgId: demand.demand_org_id,
          allocatedQuantity: allocInDemandUnit, allocatedUnit: demand.quantity_unit,
          score: cand.ranking.score, explanation: cand.ranking.explanation
        });

        createAlert(demand.demand_org_id, null, 'match', '🍱 Food Match Found!',
          `Matched ${allocInDemandUnit} ${demand.quantity_unit} of ${sp.food_name}. ${cand.ranking.explanation}`);
        createAlert(sp.donor_org_id, null, 'match', '✅ Food Matched',
          `Allocated ${allocInDemandUnit} ${demand.quantity_unit} of ${sp.food_name} to ${demandOrg.name}.`);

        // FINISH ROUTING LEFTOVER SURPLUS (Flowchart Branches FB, J, K, BIO, REVIEW)
        if (!isInventory && newSurplusRem > 0.001) {
          const donorOrg = cand.donorOrg || db.prepare('SELECT * FROM organizations WHERE id = ?').get(sp.donor_org_id);
          const fallback = tryFoodBankFallback({ ...sp, remaining_quantity: newSurplusRem }, donorOrg, routeResults);
          if (fallback) {
            matchesCreated.push(fallback);
            if (fallback.remainingQuantity > 0.001) {
              const freshSpAfter = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(sp.id);
              const spExpiryMs = parseSqliteDate(sp.remaining_usable_time);
              const timeLeftMs = spExpiryMs ? spExpiryMs - Date.now() : 0;
              if (timeLeftMs < 2 * 60 * 60 * 1000) {
                routeToBiogas(freshSpAfter,
                  `Food banks could accept only part of the remaining surplus; ${fallback.remainingQuantity} ${sp.quantity_unit} remain and food expires in ${Math.round(timeLeftMs / 60000)} minutes`,
                  biogasRouteResults);
              } else {
                routeToReview(freshSpAfter,
                  `Food banks could accept only part of the remaining surplus; ${fallback.remainingQuantity} ${sp.quantity_unit} still needs a destination.`);
              }
            }
          } else {
            const spExpiryMs = parseSqliteDate(sp.remaining_usable_time);
            const timeLeftMs = spExpiryMs ? spExpiryMs - Date.now() : 0;
            const freshSpAfter = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(sp.id);
            if (timeLeftMs < 2 * 60 * 60 * 1000) {
              routeToBiogas(freshSpAfter,
                `No further compatible demand or food bank found; food expires in ${Math.round(timeLeftMs / 60000)} minutes`,
                biogasRouteResults);
            } else {
              routeToReview(freshSpAfter,
                'No further compatible direct demand or food bank could be confirmed. Operator review required to determine best destination.');
            }
          }
        }
      }
    }
  });

  executeTx();

  if (matchesCreated.length > 0) {
    console.log(`[Matching] Executed unified matching -> created ${matchesCreated.length} allocations`);
  }

  return matchesCreated.length > 0 ? matchesCreated[0] : null;
}

/**
 * Pre-computes road routes from a donor org to each candidate org.
 * Called BEFORE runUnifiedMatching (async, outside the sync SQLite transaction).
 * Returns Map(orgId → routeResult)
 * @param {Object} donorOrg - org with location_lat, location_lng
 * @param {Array}  candidateOrgs - array of org objects with id, location_lat, location_lng
 */
async function precomputeRoutes(donorOrg, candidateOrgs) {
  const routeResults = new Map();
  if (!donorOrg?.location_lat || !donorOrg?.location_lng) return routeResults;

  for (const org of candidateOrgs) {
    if (!org?.location_lat || !org?.location_lng) continue;
    try {
      const result = await getRoute(donorOrg.location_lat, donorOrg.location_lng, org.location_lat, org.location_lng);
      routeResults.set(org.id, result);
    } catch (err) {
      console.warn(`[Matching] precomputeRoutes error for org ${org.id}:`, err.message);
    }
  }
  return routeResults;
}

/** Re-run open demands when newly received/manual food-bank stock becomes available. */
async function matchOpenDemandsForInventory() {
  const openDemands = db.prepare(`
    SELECT dr.id, dr.demand_org_id
    FROM demand_registrations dr
    JOIN organizations o ON o.id = dr.demand_org_id
    WHERE dr.status IN ('open', 'partially_fulfilled')
      AND o.status = 'active' AND o.verified = 1
      AND COALESCE(dr.remaining_quantity, dr.quantity_needed) > 0
    ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END
  `).all();
  const suppliers = db.prepare(`
    SELECT DISTINCT o.id, o.location_lat, o.location_lng
    FROM organizations o
    WHERE o.status = 'active' AND o.verified = 1 AND (
      EXISTS (
        SELECT 1 FROM surplus_posts sp
        WHERE sp.donor_org_id = o.id
          AND sp.status IN ('available', 'partially_matched', 'review_required')
          AND (sp.status != 'review_required' OR COALESCE(sp.review_reason, '') NOT LIKE 'Biogas routing unavailable:%')
          AND COALESCE(sp.remaining_quantity, sp.quantity) > 0
      ) OR (o.type LIKE '%food_bank%' AND EXISTS (
        SELECT 1 FROM food_bank_inventory i WHERE i.org_id = o.id
          AND COALESCE(i.quantity_remaining, 0) > 0
          AND COALESCE(i.biogas_status, 'available') = 'available'
          AND i.expiry_date IS NOT NULL AND date(i.expiry_date) >= date('now')
      ))
    )
  `).all();
  for (const row of openDemands) {
    const demandOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(row.demand_org_id);
    if (!demandOrg) continue;
    const routeResults = await precomputeRoutes(demandOrg, suppliers);
    runUnifiedMatching({ demandId: row.id, routeResults });
  }
  return openDemands.length;
}

/**
 * Pre-computes road routes from a donor org to all active biogas facilities.
 * Called BEFORE runUnifiedMatching so the sync transaction can use road distances.
 * Returns Map(facilityId → routeResult)
 * @param {Object} donorOrg
 */
async function precomputeRoutesToBiogas(donorOrg) {
  const routeResults = new Map();
  if (!donorOrg?.location_lat || !donorOrg?.location_lng) return routeResults;

  let facilities = [];
  try {
    facilities = db.prepare(`SELECT id, location_lat, location_lng FROM biogas_facilities WHERE status = 'active' AND verified = 1 AND COALESCE(is_available, 1) = 1`).all();
  } catch { return routeResults; }

  for (const fac of facilities) {
    if (!fac.location_lat || !fac.location_lng) continue;
    try {
      const result = await getRoute(donorOrg.location_lat, donorOrg.location_lng, fac.location_lat, fac.location_lng);
      routeResults.set(fac.id, result);
    } catch (err) {
      console.warn(`[Matching] precomputeRoutesToBiogas error for facility ${fac.id}:`, err.message);
    }
  }
  return routeResults;
}

/**
 * Periodic safety sweep for donor surplus and food-bank stock. Expired bank
 * stock is reserved from human-food use and routed to a real eligible facility.
 */
async function processExpiredSurplus() {
  const expiredDemands = expireOverdueDemands();
  const expiredRows = db.prepare(`
    SELECT id, donor_org_id, remaining_usable_time
    FROM surplus_posts
    WHERE remaining_usable_time IS NOT NULL
      AND status IN ('available', 'partially_matched', 'review_required', 'matched')
      AND (
        (COALESCE(remaining_quantity, quantity) > 0.001 AND status != 'matched')
        OR EXISTS (SELECT 1 FROM matches m WHERE m.surplus_id = surplus_posts.id AND m.status IN ('pending', 'confirmed'))
      )
      AND (status != 'review_required' OR COALESCE(review_reason, '') NOT LIKE 'Biogas routing unavailable:%')
    ORDER BY remaining_usable_time ASC
  `).all().filter(row => {
    const expiry = parseSqliteDate(row.remaining_usable_time);
    return expiry != null && !Number.isNaN(expiry) && expiry <= Date.now();
  }).slice(0, 100);

  const routesByDonor = new Map();
  let processed = 0;
  for (const row of expiredRows) {
    if (!routesByDonor.has(row.donor_org_id)) {
      const donor = db.prepare('SELECT * FROM organizations WHERE id = ?').get(row.donor_org_id);
      routesByDonor.set(row.donor_org_id, donor ? await precomputeRoutesToBiogas(donor) : new Map());
    }

    const result = db.transaction(() => {
      const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(row.id);
      if (!surplus) return null;
      const expiry = parseSqliteDate(surplus.remaining_usable_time);
      if (!expiry || expiry > Date.now()) return null;
      if (!['available', 'partially_matched', 'review_required', 'matched'].includes(surplus.status)) return null;
      if (surplus.status === 'review_required' && String(surplus.review_reason || '').startsWith('Biogas routing unavailable:')) return null;
      const allocatedMatches = db.prepare(`
        SELECT * FROM matches WHERE surplus_id = ? AND status IN ('pending', 'confirmed')
      `).all(surplus.id);
      let restoredQuantity = 0;
      for (const match of allocatedMatches) {
        const allocated = Math.max(0, Number(match.allocated_quantity) || 0);
        const converted = convertQuantity(allocated, match.allocated_unit || surplus.quantity_unit, surplus.quantity_unit, surplus.food_type);
        if (converted.success) restoredQuantity += converted.convertedQty;
        db.prepare("UPDATE matches SET status = 'cancelled', notes = 'Cancelled: donor surplus expired before receipt confirmation' WHERE id = ?")
          .run(match.id);
        if (match.demand_id && allocated > 0) {
          db.prepare(`
            UPDATE demand_registrations
            SET remaining_quantity = MIN(quantity_needed, COALESCE(remaining_quantity, 0) + ?),
                status = CASE WHEN COALESCE(remaining_quantity, 0) + ? >= quantity_needed THEN 'open' ELSE 'partially_fulfilled' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(allocated, allocated, match.demand_id);
          createAlert(match.demand_org_id, null, 'alert', 'Food match expired before receipt',
            `The ${surplus.food_name} match expired before receipt was confirmed. Your unmet demand has been reopened.`);
        }
      }
      const unallocated = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);
      const remaining = Math.min(Number(surplus.quantity), unallocated + restoredQuantity);
      if (remaining <= 0.001) return null;
      db.prepare('UPDATE surplus_posts SET remaining_quantity = ? WHERE id = ?').run(remaining, surplus.id);
      return routeToBiogas({ ...surplus, remaining_quantity: remaining }, 'Surplus expired; no longer safe for human consumption', routesByDonor.get(row.donor_org_id));
    })();
    if (result) processed++;
  }

  const inventoryRows = db.prepare(`
    SELECT i.id, i.org_id, i.expiry_date
    FROM food_bank_inventory i
    WHERE i.expiry_date IS NOT NULL
      AND (COALESCE(i.quantity_remaining, 0) > 0.001 OR EXISTS (
        SELECT 1 FROM matches m WHERE m.source_type = 'food_bank_inventory'
          AND m.source_inventory_id = i.id AND m.status IN ('pending', 'confirmed')
      ))
      AND COALESCE(i.biogas_status, 'available') = 'available'
    ORDER BY i.expiry_date ASC
    LIMIT 500
  `).all();
  const expiredInventoryRows = inventoryRows.filter(row => {
    const expiry = parseInventoryExpiry(row.expiry_date);
    return expiry != null && expiry <= Date.now();
  });
  const routesByFoodBank = new Map();
  let processedInventory = 0;
  for (const row of expiredInventoryRows) {
    if (!routesByFoodBank.has(row.org_id)) {
      const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(row.org_id);
      routesByFoodBank.set(row.org_id, org ? await precomputeRoutesToBiogas(org) : new Map());
    }
    const result = db.transaction(() => {
      const item = db.prepare('SELECT * FROM food_bank_inventory WHERE id = ?').get(row.id);
      if (!item || item.biogas_status !== 'available') return null;
      const expiry = parseInventoryExpiry(item.expiry_date);
      if (expiry == null || expiry > Date.now()) return null;

      // Unreceived offers still belong to the bank. Cancel them, reopen their
      // demands, and include all reserved stock in the biogas shipment.
      const outstanding = db.prepare(`
        SELECT * FROM matches WHERE source_type = 'food_bank_inventory'
          AND source_inventory_id = ? AND status IN ('pending', 'confirmed')
      `).all(item.id);
      let restoreQty = 0;
      for (const match of outstanding) {
        const allocated = Number(match.allocated_quantity || 0);
        const converted = convertQuantity(allocated, match.allocated_unit || item.quantity_unit, item.quantity_unit, item.food_type);
        const restore = converted.success ? converted.convertedQty : 0;
        restoreQty += restore;
        db.prepare(`UPDATE matches SET status = 'cancelled', notes = 'Cancelled: source inventory expired before receipt confirmation' WHERE id = ?`)
          .run(match.id);
        if (match.demand_id && allocated > 0) {
          db.prepare(`
            UPDATE demand_registrations
            SET remaining_quantity = MIN(quantity_needed, COALESCE(remaining_quantity, 0) + ?),
                status = CASE WHEN COALESCE(remaining_quantity, 0) + ? >= quantity_needed THEN 'open' ELSE 'partially_fulfilled' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(allocated, allocated, match.demand_id);
          createAlert(match.demand_org_id, null, 'alert', 'Food match expired before dispatch',
            `The ${item.food_name} match could not proceed because the food-bank stock expired. Your demand has been reopened.`);
        }
      }
      const routeQuantity = Number(item.quantity_remaining || 0) + restoreQty;
      if (routeQuantity <= 0.001) return null;
      db.prepare('UPDATE food_bank_inventory SET quantity_remaining = ? WHERE id = ?').run(routeQuantity, item.id);
      const routableItem = { ...item, quantity_remaining: routeQuantity };
      return routeInventoryToBiogas(routableItem, 'Food-bank inventory expired; no longer available for human consumption', routesByFoodBank.get(row.org_id));
    })();
    if (result) processedInventory++;
  }

  return {
    scanned: expiredRows.length + inventoryRows.length,
    processed: processed + processedInventory,
    processedSurplus: processed,
    processedInventory,
    expiredDemands
  };
}

/**
 * Close one-time demands once their required-by deadline has passed. Recurring
 * demands stay active; their deadline applies to the current occurrence only.
 * Pending allocations are cancelled and their reserved stock is released before
 * the unmet demand is marked expired. Accepted matches remain untouched while
 * awaiting receipt confirmation.
 */
function expireOverdueDemands() {
  const overdueRows = db.prepare(`
    SELECT id, required_by
    FROM demand_registrations
    WHERE status IN ('open', 'partially_fulfilled', 'searching')
      AND COALESCE(is_recurring, 0) = 0
      AND required_by IS NOT NULL AND TRIM(required_by) != ''
      AND COALESCE(remaining_quantity, quantity_needed) > 0.001
    ORDER BY required_by ASC
  `).all().filter(row => {
    const deadline = parseSqliteDate(row.required_by);
    return deadline != null && !Number.isNaN(deadline) && deadline <= Date.now();
  }).slice(0, 500);

  const cancelPending = db.prepare(`
    SELECT * FROM matches WHERE demand_id = ? AND status = 'pending'
  `);
  let expiredCount = 0;

  for (const { id } of overdueRows) {
    const didExpire = db.transaction(() => {
      const demand = db.prepare('SELECT * FROM demand_registrations WHERE id = ?').get(id);
      if (!demand || !['open', 'partially_fulfilled', 'searching'].includes(demand.status) ||
          Number(demand.is_recurring) === 1 || !demand.required_by ||
          parseSqliteDate(demand.required_by) > Date.now() ||
          Number(demand.remaining_quantity ?? demand.quantity_needed) <= 0.001) return false;

      let cancelledAllocation = 0;
      for (const match of cancelPending.all(id)) {
        const allocated = Math.max(0, Number(match.allocated_quantity) || 0);
        if (allocated > 0) {
          const isInventory = match.source_type === 'food_bank_inventory';
          const source = isInventory
            ? db.prepare('SELECT * FROM food_bank_inventory WHERE id = ?').get(match.source_inventory_id)
            : db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(match.surplus_id);
          if (source && isInventory) {
            const converted = convertQuantity(allocated, match.allocated_unit || demand.quantity_unit, source.quantity_unit, source.food_type);
            const restore = converted.success ? converted.convertedQty : allocated;
            db.prepare(`UPDATE food_bank_inventory
              SET quantity_remaining = MIN(quantity_received, COALESCE(quantity_remaining, 0) + ?)
              WHERE id = ?`).run(Math.round(restore * 100) / 100, source.id);
          } else if (source) {
            const converted = convertQuantity(allocated, match.allocated_unit || demand.quantity_unit, source.quantity_unit, source.food_type);
            const restore = converted.success ? converted.convertedQty : allocated;
            db.prepare(`UPDATE surplus_posts
              SET remaining_quantity = MIN(quantity, COALESCE(remaining_quantity, quantity) + ?),
                  status = 'available', updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`).run(Math.round(restore * 100) / 100, source.id);
          }
          cancelledAllocation += allocated;
        }
        db.prepare(`UPDATE matches SET status = 'cancelled',
          notes = 'Cancelled: recipient demand deadline passed' WHERE id = ?`).run(match.id);
      }

      db.prepare(`UPDATE demand_registrations
        SET remaining_quantity = MIN(quantity_needed, COALESCE(remaining_quantity, 0) + ?),
            status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(cancelledAllocation, id);
      return { demandOrgId: demand.demand_org_id };
    })();

    if (didExpire) {
      expiredCount++;
      createAlert(didExpire.demandOrgId, null, 'alert', 'Demand deadline passed',
        'Your unmet one-time demand expired after its required-by date. Any pending allocations were released.');
    }
  }

  return expiredCount;
}

/**
 * Backward-compatible alias for existing callers.
 */
function runMatching(surplusId) {
  return runUnifiedMatching({ surplusId });
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

module.exports = {
  runMatching,
  runUnifiedMatching,
  precomputeRoutes,
  matchOpenDemandsForInventory,
  precomputeRoutesToBiogas,
  processExpiredSurplus,
  expireOverdueDemands,
  checkCompatibility,
  rankCandidate,
  convertQuantity,
  generateSurplusPredictions,
  createAlert,
  routeToBiogas,
  routeToReview,
  routeToBiogasFacility,
  isFoodAcceptedByProfile
};
