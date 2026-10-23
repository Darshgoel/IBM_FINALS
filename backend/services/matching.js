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
    'cooked_meals', 'hot_meals', 'prepared_meals', 'meals', 'rice_curry', 'cooked_food',
    'curry', 'pulav', 'pulao', 'biryani', 'dinner', 'lunch', 'breakfast', 'sandwiches',
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

    if (surplusTypeNorm.includes(pNorm) || pNorm.includes(surplusTypeNorm)) return true;
    if (surplusNameNorm.includes(pNorm) || pNorm.includes(surplusNameNorm)) return true;

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
  } else if (surplusTypeNorm.includes(reqNorm) || reqNorm.includes(surplusTypeNorm)) {
    matchesDemand = true;
  } else if (surplusNameNorm.includes(reqNorm) || reqNorm.includes(surplusNameNorm)) {
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
  const iso = s.includes('T')
    ? (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z')
    : s.replace(' ', 'T') + 'Z';
  const ts = new Date(iso).getTime();
  return isNaN(ts) ? new Date(str).getTime() : ts;
}

// ── 5. HARD COMPATIBILITY GATE ────────────────────────────────────────────────

function checkCompatibility(surplus, demand, donorOrg, demandOrg, demandProfile) {
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

  if (donorOrg?.location_lat && demandOrg?.location_lat) {
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
  }

  const estimatedArrival = now + transitMinutes * 60 * 1000;
  const safeFreshnessBufferMs = surplusExpiry - estimatedArrival;
  if (safeFreshnessBufferMs < 15 * 60 * 1000) {
    return {
      pass: false,
      reason: `Food cannot arrive before expiration (estimated arrival: ${new Date(estimatedArrival).toLocaleTimeString()}, safe until: ${new Date(surplusExpiry).toLocaleTimeString()})`
    };
  }

  if (demand.required_by) {
    const demandDeadline = parseSqliteDate(demand.required_by);
    if (!isNaN(demandDeadline)) {
      if (estimatedArrival > demandDeadline) {
        return {
          pass: false,
          reason: `Estimated arrival (${new Date(estimatedArrival).toLocaleTimeString()}) is after recipient deadline (${new Date(demandDeadline).toLocaleTimeString()})`
        };
      }
      if (surplusExpiry < demandDeadline - 30 * 60 * 1000) {
        return {
          pass: false,
          reason: `Surplus expires at ${new Date(surplusExpiry).toLocaleTimeString()}, which is before recipient meal time ${new Date(demandDeadline).toLocaleTimeString()}`
        };
      }
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

  return { pass: true, distanceKm, estimatedArrival, surplusExpiry, convertedSurplus, potentialAlloc, surplusRem, demandRem };
}

// ── 6. EXPLAINABLE RANKING ENGINE ─────────────────────────────────────────────

const URGENCY_POINTS = { emergency: 15, immediate: 11, regular: 7, planned: 3 };

function rankCandidate(gateResult, surplus, demand, demandOrg) {
  let score = 0;
  const factors = {};

  let urgencyPts = URGENCY_POINTS[demand.urgency] || 7;
  let deadlinePts = 2;
  if (demand.required_by) {
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
  const hoursMargin = Math.max(0.1, Math.round(safeHours * 10) / 10);
  const percentCovered = Math.round((gateResult.potentialAlloc / gateResult.demandRem) * 100);
  const explanation = `Compatible ${surplus.food_type.replace('_', ' ')}, ${distText}. Covers ${gateResult.potentialAlloc} of ${gateResult.demandRem} requested ${demand.quantity_unit} (${percentCovered}% coverage). Urgency: ${demand.urgency}, safe arrival with ${hoursMargin}h freshness buffer.`;

  return { score: totalScore, factors, explanation, allocQty: gateResult.potentialAlloc, demandRem: gateResult.demandRem, surplusRem: gateResult.surplusRem, distanceKm: gateResult.distanceKm };
}

// ── 7. LIFECYCLE ROUTING HELPERS ──────────────────────────────────────────────

/**
 * Step 1/7: Routes a surplus post to biogas. Creates audit record and notifies donor.
 */
function routeToBiogas(surplus, reason) {
  const qty = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);

  db.prepare(`
    UPDATE surplus_posts
    SET status = 'biogas_routed', biogas_reason = ?, remaining_quantity = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, surplus.id);

  db.prepare(`
    INSERT INTO biogas_routes (id, surplus_id, donor_org_id, food_name, food_type, quantity, quantity_unit, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), surplus.id, surplus.donor_org_id, surplus.food_name, surplus.food_type, qty, surplus.quantity_unit, reason);

  createAlert(surplus.donor_org_id, null, 'biogas', '♻️ Surplus Routed to Biogas',
    `Your surplus "${surplus.food_name}" (${qty} ${surplus.quantity_unit}) has been safely directed to a biogas processing centre. Reason: ${reason}`);

  console.log(`[Matching] Biogas route: surplus ${surplus.id} — ${reason}`);
  return { surplusId: surplus.id, destination: 'biogas', reason };
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

  const timeToExpiryMs = expiryMs - now;

  // Missing or uncertain location data -> flowchart branch C: Missing or uncertain data -> REVIEW
  if (!donorOrg?.location_lat || !donorOrg?.location_lng ||
      (donorOrg.location_lat === 0 && donorOrg.location_lng === 0)) {
    return {
      feasible: false,
      missingData: true,
      reason: 'Donor location is missing or uncertain — delivery feasibility cannot be verified without manual operator review'
    };
  }

  // Minimum feasible window: 40 min transit + 15 min safety buffer
  if (timeToExpiryMs < 55 * 60 * 1000) {
    return {
      feasible: false,
      missingData: false,
      reason: `Only ${Math.round(timeToExpiryMs / 60000)} minutes until expiry — insufficient time for any safe delivery`
    };
  }

  return { feasible: true, missingData: false, reason: null };
}

/**
 * Step 6: Food bank fallback — validates food type, cold storage, capacity AND delivery timing.
 * Returns a match record object on success, null if no suitable food bank found.
 */
function tryFoodBankFallback(surplus, donorOrg) {
  const now = Date.now();
  const expiryMs = parseSqliteDate(surplus.remaining_usable_time);
  const remainingQty = surplus.remaining_quantity != null ? Number(surplus.remaining_quantity) : Number(surplus.quantity);
  if (remainingQty <= 0.001) return null;

  const foodBankCandidates = db.prepare(`
    SELECT o.*, dp.food_requirements, dp.dietary_restrictions, dp.receiving_capacity,
           dp.storage_capacity, dp.serving_capacity
    FROM organizations o
    JOIN demand_org_profiles dp ON o.id = dp.org_id
    WHERE o.status = 'active' AND o.type LIKE '%food_bank%'
  `).all();

  if (!foodBankCandidates.length) return null;

  let chosen = null;
  let chosenDistance = Infinity;

  for (const fb of foodBankCandidates) {
    let dist = null;
    if (donorOrg?.location_lat && fb.location_lat) {
      dist = haversineDistance(donorOrg.location_lat, donorOrg.location_lng, fb.location_lat, fb.location_lng);
      if (dist !== null && dist > MAX_MATCH_DISTANCE_KM) continue;
    }

    // Delivery timing: food bank must be reachable before expiry with 15 min buffer
    if (expiryMs && !isNaN(expiryMs)) {
      const transitMins = dist != null ? Math.round(40 + (dist / 25) * 60) : 45;
      const estimatedArrival = now + transitMins * 60 * 1000;
      if (estimatedArrival + 15 * 60 * 1000 > expiryMs) continue;
    }

    // Food type compatibility — food bank profile constraints must be satisfied
    const profileFoodReqs = parseTags(fb.food_requirements);
    if (!isFoodAcceptedByProfile(surplus.food_type, surplus.food_name, profileFoodReqs)) {
      continue;
    }

    // Cold storage check for perishables (require positive evidence)
    const isPerishable = findCluster(surplus.food_type) === 'dairy' ||
      findCluster(surplus.food_type) === 'cooked_meals';
    const storageStr = normalizeString(fb.storage_capacity || '');
    if (isPerishable) {
      const hasCold = /(refrigerat|cold storage|freezer|chilled|cold chain)/i.test(storageStr);
      if (!hasCold) continue;
    }

    // Receiving capacity check
    if (fb.receiving_capacity) {
      const rcStr = String(fb.receiving_capacity).trim();
      const rcMatch = rcStr.match(/^(\d+(?:\.\d+)?)\s*(\w+)?/);
      if (rcMatch) {
        const rcQty = parseFloat(rcMatch[1]);
        const rcUnit = (rcMatch[2] || surplus.quantity_unit || '').toLowerCase();
        const surplusUnit = (surplus.quantity_unit || '').toLowerCase();
        const fromNorm = UNIT_SYNONYMS[normalizeString(rcUnit)] || normalizeString(rcUnit);
        const toNorm = UNIT_SYNONYMS[normalizeString(surplusUnit)] || normalizeString(surplusUnit);
        if (!isNaN(rcQty) && rcQty > 0 && fromNorm === toNorm && remainingQty > rcQty) continue;
      }
    }

    const d = dist != null ? dist : Infinity;
    if (d < chosenDistance) {
      chosenDistance = d;
      chosen = fb;
    }
  }

  if (!chosen) return null;

  const matchId = uuidv4();
  const distText = chosenDistance !== Infinity ? `${chosenDistance.toFixed(1)} km` : 'nearby';
  const explanation = `No immediate direct demand found. Routed ${remainingQty} ${surplus.quantity_unit} to food bank reserve hub "${chosen.name}" (${distText}) for community distribution.`;

  db.prepare(`
    INSERT INTO matches (id, surplus_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes)
    VALUES (?, ?, ?, 35, ?, ?, ?, 'pending', 'fallback_food_bank')
  `).run(matchId, surplus.id, chosen.id, remainingQty, surplus.quantity_unit, explanation);

  db.prepare(`
    UPDATE surplus_posts SET status = 'matched', remaining_quantity = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(surplus.id);

  createAlert(surplus.donor_org_id, null, 'fallback', '🏦 Surplus Routed to Food Bank',
    `No immediate direct demand found. ${remainingQty} ${surplus.quantity_unit} of "${surplus.food_name}" safely routed to ${chosen.name}.`);

  createAlert(chosen.id, null, 'incoming', '📦 Incoming Food Bank Delivery',
    `${remainingQty} ${surplus.quantity_unit} of "${surplus.food_name}" from donor has been allocated to your food bank.`);

  return { matchId, fallback: true, foodBankId: chosen.id, foodBankName: chosen.name, explanation };
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
function runUnifiedMatching({ surplusId, demandId } = {}) {
  const matchesCreated = [];

  const executeTx = db.transaction(() => {
    // ── PATH A: Donor posted surplus (or match specific surplus) ─────────────
    if (surplusId) {
      const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(surplusId);
      if (!surplus) return;

      // STEP 1 — Safety gate: explicitly unsafe → biogas immediately
      if (surplus.unsafe === 1) {
        routeToBiogas(surplus, 'Food was marked unsafe by the donor or platform');
        return;
      }
      // STEP 1 — Expired → biogas immediately
      const now = Date.now();
      const expiryMs = parseSqliteDate(surplus.remaining_usable_time);
      if (!expiryMs || isNaN(expiryMs) || expiryMs <= now) {
        routeToBiogas(surplus, 'Surplus food has expired and cannot be offered for consumption');
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
          routeToBiogas(surplus, feasibility.reason);
        }
        return;
      }
      // Missing data but still feasible → flag for review but continue matching
      // (per-demand gates in checkCompatibility handle per-route timing)

      // STEP 3 — Find open / partially fulfilled demands from active orgs
      const demands = db.prepare(`
        SELECT dr.*, o.location_lat, o.location_lng, o.status as org_status, o.name as org_name
        FROM demand_registrations dr
        JOIN organizations o ON dr.demand_org_id = o.id
        WHERE dr.status IN ('open', 'partially_fulfilled')
          AND o.status = 'active'
          AND COALESCE(dr.remaining_quantity, dr.quantity_needed) > 0
        ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 WHEN 'regular' THEN 3 WHEN 'planned' THEN 4 END
      `).all();

      const candidates = [];
      for (const dem of demands) {
        const demandOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(dem.demand_org_id);
        const demandProfile = db.prepare('SELECT * FROM demand_org_profiles WHERE org_id = ?').get(dem.demand_org_id);
        const gate = checkCompatibility({ ...surplus, remaining_quantity: currentSurplusRem }, dem, donorOrg, demandOrg, demandProfile);
        if (gate.pass) {
          const ranking = rankCandidate(gate, surplus, dem, demandOrg);
          candidates.push({ demand: dem, demandOrg, ranking });
        }
      }

      // STEP 4 — Rank eligible demands
      candidates.sort((a, b) => b.ranking.score - a.ranking.score);

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
          INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(matchId, surplus.id, dem.id, dem.demand_org_id,
          cand.ranking.score, allocInDemandUnit, freshDem.quantity_unit,
          cand.ranking.explanation, cand.ranking.explanation);

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
        const fallback = tryFoodBankFallback({ ...surplus, remaining_quantity: currentSurplusRem }, donorOrg);
        if (fallback) {
          matchesCreated.push(fallback);
          currentSurplusRem = 0;
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
              `No compatible demand or food bank found; food expires in ${Math.round(timeLeftMs / 60000)} minutes`);
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

      // Find active surplus — include available and partially matched
      const surplusPosts = db.prepare(`
        SELECT sp.*, o.location_lat, o.location_lng, o.status as org_status, o.name as org_name
        FROM surplus_posts sp
        JOIN organizations o ON sp.donor_org_id = o.id
        WHERE sp.status IN ('available', 'partially_matched')
          AND o.status = 'active'
          AND COALESCE(sp.remaining_quantity, sp.quantity) > 0
        ORDER BY sp.remaining_usable_time ASC
      `).all();

      const candidates = [];
      for (const sp of surplusPosts) {
        const now = Date.now();
        const spExpiry = parseSqliteDate(sp.remaining_usable_time);

        // Lifecycle gap fix: expired surplus encountered during demand matching routes to biogas
        if (!spExpiry || isNaN(spExpiry) || spExpiry <= now) {
          routeToBiogas(sp, 'Surplus food expired prior to allocation');
          continue;
        }

        // Safety gate: explicitly unsafe surplus routes to biogas
        if (sp.unsafe === 1) {
          routeToBiogas(sp, 'Food was marked unsafe by the donor or platform');
          continue;
        }

        const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(sp.donor_org_id);

        // Missing location or delivery feasibility check (Flowchart Branch C)
        const feasibility = estimateDeliveryFeasibility(sp, donorOrg);
        if (!feasibility.feasible) {
          if (feasibility.missingData) {
            routeToReview(sp, feasibility.reason);
          } else {
            routeToBiogas(sp, feasibility.reason);
          }
          continue;
        }

        const gate = checkCompatibility(sp, { ...demand, remaining_quantity: currentDemandRem }, donorOrg, demandOrg, demandProfile);
        if (gate.pass) {
          const ranking = rankCandidate(gate, sp, demand, demandOrg);
          candidates.push({ surplus: sp, donorOrg, ranking });
        }
      }

      candidates.sort((a, b) => b.ranking.score - a.ranking.score);

      for (const cand of candidates) {
        if (currentDemandRem <= 0.001) break;

        const sp = cand.surplus;
        const freshSp = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(sp.id);
        let freshSurplusRem = freshSp.remaining_quantity != null ? Number(freshSp.remaining_quantity) : Number(freshSp.quantity);
        if (freshSurplusRem <= 0.001) continue;

        const conv = convertQuantity(freshSurplusRem, sp.quantity_unit, demand.quantity_unit, sp.food_type);
        if (!conv.success) continue;

        const allocInDemandUnit = Math.min(conv.convertedQty, currentDemandRem);
        if (allocInDemandUnit <= 0.001) continue;

        const convBack = convertQuantity(allocInDemandUnit, demand.quantity_unit, sp.quantity_unit, sp.food_type);
        const allocInSurplusUnit = convBack.success ? convBack.convertedQty : allocInDemandUnit;

        const newSurplusRem = Math.max(0, freshSurplusRem - allocInSurplusUnit);
        const newSurplusStatus = newSurplusRem <= 0.001 ? 'matched' : 'partially_matched';

        db.prepare(`
          UPDATE surplus_posts SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(Math.round(newSurplusRem * 100) / 100, newSurplusStatus, sp.id);

        currentDemandRem = Math.max(0, currentDemandRem - allocInDemandUnit);
        const newDemandStatus = currentDemandRem <= 0.001 ? 'fulfilled' : 'partially_fulfilled';

        db.prepare(`
          UPDATE demand_registrations SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(Math.round(currentDemandRem * 100) / 100, newDemandStatus, demand.id);

        const matchId = uuidv4();
        db.prepare(`
          INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, allocated_quantity, allocated_unit, explanation, status, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(matchId, sp.id, demand.id, demand.demand_org_id,
          cand.ranking.score, allocInDemandUnit, demand.quantity_unit,
          cand.ranking.explanation, cand.ranking.explanation);

        matchesCreated.push({
          matchId, surplusId: sp.id, demandId: demand.id, demandOrgId: demand.demand_org_id,
          allocatedQuantity: allocInDemandUnit, allocatedUnit: demand.quantity_unit,
          score: cand.ranking.score, explanation: cand.ranking.explanation
        });

        createAlert(demand.demand_org_id, null, 'match', '🍱 Food Match Found!',
          `Matched ${allocInDemandUnit} ${demand.quantity_unit} of ${sp.food_name}. ${cand.ranking.explanation}`);
        createAlert(sp.donor_org_id, null, 'match', '✅ Surplus Matched',
          `Allocated ${allocInDemandUnit} ${demand.quantity_unit} of ${sp.food_name} to ${demandOrg.name}.`);

        // FINISH ROUTING LEFTOVER SURPLUS (Flowchart Branches FB, J, K, BIO, REVIEW)
        if (newSurplusRem > 0.001) {
          const donorOrg = cand.donorOrg || db.prepare('SELECT * FROM organizations WHERE id = ?').get(sp.donor_org_id);
          const fallback = tryFoodBankFallback({ ...sp, remaining_quantity: newSurplusRem }, donorOrg);
          if (fallback) {
            matchesCreated.push(fallback);
          } else {
            const spExpiryMs = parseSqliteDate(sp.remaining_usable_time);
            const timeLeftMs = spExpiryMs ? spExpiryMs - Date.now() : 0;
            const freshSpAfter = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(sp.id);
            if (timeLeftMs < 2 * 60 * 60 * 1000) {
              routeToBiogas(freshSpAfter,
                `No further compatible demand or food bank found; food expires in ${Math.round(timeLeftMs / 60000)} minutes`);
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
  checkCompatibility,
  rankCandidate,
  convertQuantity,
  generateSurplusPredictions,
  createAlert,
  routeToBiogas,
  routeToReview,
  isFoodAcceptedByProfile
};
