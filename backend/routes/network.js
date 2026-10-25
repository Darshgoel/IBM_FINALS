const express = require('express');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { suggestLocations } = require('../services/geocoding');
const {
  convertQuantity,
  isFoodAcceptedByProfile,
  checkDietarySafety,
  runUnifiedMatching,
  precomputeRoutes,
  precomputeRoutesToBiogas
} = require('../services/matching');

const router = express.Router();
const routingSurplusIds = new Set();

router.use(authenticate);
router.use(requireRole('network_admin', 'network_intelligence', 'admin'));

// Helper to format remaining time human-readable
function formatTimeRemaining(hours) {
  if (hours <= 0) return 'Expired';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function canonicalUnit(raw) {
  const value = String(raw || 'units').trim().toLowerCase();
  const aliases = {
    kilogram: 'kg', kilograms: 'kg', kgs: 'kg', gram: 'g', grams: 'g',
    liter: 'liters', litre: 'liters', litres: 'liters', milliliter: 'ml', milliliters: 'ml',
    serving: 'servings', portion: 'servings', portions: 'servings', meal: 'servings', meals: 'servings', plate: 'servings', plates: 'servings'
  };
  return aliases[value] || value;
}

function formatUnitTotals(rows, quantityKey, unitKey) {
  const totals = new Map();
  for (const row of rows || []) {
    const quantity = Number(row[quantityKey]) || 0;
    if (quantity <= 0.0001) continue;
    const unit = canonicalUnit(row[unitKey]);
    totals.set(unit, (totals.get(unit) || 0) + quantity);
  }
  if (!totals.size) return '0';
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unit, quantity]) => `${Number(quantity.toFixed(1)).toLocaleString('en-IN')} ${unit}`)
    .join(' · ');
}

function getDemandCompletionRows() {
  return db.prepare(`
    SELECT dr.id, dr.quantity_needed, dr.quantity_unit, dr.food_requirement, dr.urgency,
           dr.remaining_quantity, dr.status, dr.demand_org_id,
           COALESCE(SUM(CASE WHEN m.status = 'completed' THEN m.allocated_quantity ELSE 0 END), 0) AS completed_quantity
    FROM demand_registrations dr
    LEFT JOIN matches m ON m.demand_id = dr.id
    JOIN organizations o ON o.id = dr.demand_org_id
    WHERE dr.status != 'cancelled' AND o.status = 'active' AND o.verified = 1
    GROUP BY dr.id
  `).all();
}

function demandFulfillmentRate(rows) {
  const applicable = rows.filter(row => Number(row.quantity_needed) > 0);
  if (!applicable.length) return 0;
  const total = applicable.reduce((sum, row) => {
    const requested = Number(row.quantity_needed) || 0;
    const delivered = Math.min(requested, Math.max(0, Number(row.completed_quantity) || 0));
    return sum + delivered / requested;
  }, 0);
  return Math.round((total / applicable.length) * 100);
}

function completedMatchRows(extraWhere = '', params = []) {
  return db.prepare(`
    SELECT m.allocated_quantity AS quantity, m.allocated_unit AS unit,
           COALESCE(sp.food_type, fi.food_type, '') AS food_type,
           m.completed_at, m.matched_at
    FROM matches m
    LEFT JOIN surplus_posts sp ON m.source_type = 'surplus' AND sp.id = m.surplus_id
    LEFT JOIN food_bank_inventory fi ON m.source_type = 'food_bank_inventory' AND fi.id = m.source_inventory_id
    WHERE m.status = 'completed' ${extraWhere}
  `).all(...params);
}

function massEquivalentKg(rows) {
  let kg = 0;
  let unconvertible = 0;
  for (const row of rows) {
    const converted = convertQuantity(Number(row.quantity) || 0, row.unit || 'kg', 'kg', row.food_type || '');
    if (converted.success) kg += converted.convertedQty;
    else if (Number(row.quantity) > 0) unconvertible += 1;
  }
  return { kg: Math.round(kg * 10) / 10, unconvertible };
}

function getWasteRiskRows(hours = 3.5) {
  return db.prepare(`
    SELECT sp.id, sp.food_name, sp.food_type, sp.donor_org_id, sp.quantity_unit,
           COALESCE(sp.remaining_quantity, sp.quantity) AS remaining_quantity,
           sp.remaining_usable_time, sp.special_instructions, sp.pickup_address,
           sp.status, o.name AS donor_name, o.location_address,
           ((julianday(sp.remaining_usable_time) - julianday('now')) * 24) AS hours_left
    FROM surplus_posts sp
    JOIN organizations o ON o.id = sp.donor_org_id
    WHERE sp.status IN ('available', 'partially_matched')
      AND o.status = 'active' AND o.verified = 1
      AND COALESCE(sp.remaining_quantity, sp.quantity) > 0.001
      AND COALESCE(sp.unsafe, 0) = 0
      AND sp.remaining_usable_time IS NOT NULL
      AND julianday(sp.remaining_usable_time) > julianday('now')
      AND julianday(sp.remaining_usable_time) <= julianday('now') + (? / 24.0)
    ORDER BY julianday(sp.remaining_usable_time) ASC
    `).all(hours);
}

function parseStorageCapacityKg(value) {
  const text = String(value || '');
  const amounts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/ig)];
  if (!amounts.length) return null;
  return amounts.reduce((sum, match) => sum + Number(match[1]), 0);
}

function parseProfileTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) return value;
  } catch (_) {}
  return String(raw).split(',').map(value => value.trim()).filter(Boolean);
}

function hasEligibleReserveReceiver(surplus) {
  const donors = db.prepare(`
    SELECT location_lat, location_lng FROM organizations WHERE id = ? AND status = 'active' AND verified = 1
  `).get(surplus.donor_org_id);
  if (!donors || donors.location_lat == null || donors.location_lng == null) return false;
  const banks = db.prepare(`
    SELECT o.id, o.location_lat, o.location_lng, dp.food_requirements, dp.dietary_restrictions,
           dp.storage_capacity, dp.receiving_capacity_kg
    FROM organizations o JOIN demand_org_profiles dp ON dp.org_id = o.id
    WHERE o.type LIKE '%food_bank%' AND o.status = 'active' AND o.verified = 1
  `).all();
  const rawExpiry = String(surplus.remaining_usable_time || '').trim();
  const expiryText = rawExpiry.includes('T') ? rawExpiry : rawExpiry.replace(' ', 'T');
  const expiry = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(expiryText) ? expiryText : `${expiryText}Z`);
  const foodType = String(surplus.food_type || '').toLowerCase();
  const perishable = /dairy|milk|yogurt|curd|cheese|paneer|butter|beverage|cooked|meal|curry|pulav|pulao|biryani/.test(foodType);

  return banks.some(bank => {
    if (bank.location_lat == null || bank.location_lng == null) return false;
    const lat1 = Number(donors.location_lat) * Math.PI / 180;
    const lat2 = Number(bank.location_lat) * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLng = (Number(bank.location_lng) - Number(donors.location_lng)) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const estimatedRoadDistanceKm = distanceKm * 1.4;
    if (!Number.isFinite(distanceKm) || estimatedRoadDistanceKm > 50) return false;
    const etaMinutes = Math.round(40 + (estimatedRoadDistanceKm / 25) * 60);
    if (!Number.isFinite(expiry) || Date.now() + (etaMinutes + 15) * 60000 > expiry) return false;
    if (!isFoodAcceptedByProfile(surplus.food_type, surplus.food_name, parseProfileTags(bank.food_requirements))) return false;
    if (!checkDietarySafety(surplus.dietary_tags, [], bank.dietary_restrictions).pass) return false;
    if (perishable && !/(refrigerat|cold storage|freezer|chilled|cold chain)/i.test(bank.storage_capacity || '')) return false;
    if (db.prepare(`SELECT 1 FROM matches WHERE source_type = 'surplus' AND surplus_id = ? AND demand_org_id = ? AND status = 'declined' LIMIT 1`).get(surplus.id, bank.id)) return false;

    const capacityKg = Number(bank.receiving_capacity_kg);
    if (!Number.isFinite(capacityKg) || capacityKg <= 0) return false;
    const todayMatches = db.prepare(`
      SELECT m.allocated_quantity, m.allocated_unit, COALESCE(sp.food_type, '') AS food_type
      FROM matches m LEFT JOIN surplus_posts sp ON sp.id = m.surplus_id
      WHERE m.demand_org_id = ? AND m.status IN ('pending', 'confirmed', 'completed')
        AND date(m.matched_at) = date('now')
    `).all(bank.id);
    const usedKg = todayMatches.reduce((sum, match) => {
      const converted = convertQuantity(Number(match.allocated_quantity) || 0, match.allocated_unit || 'kg', 'kg', match.food_type || surplus.food_type);
      return sum + (converted.success ? converted.convertedQty : Number(match.allocated_quantity) || 0);
    }, 0);
    const stock = convertQuantity(Number(surplus.remaining_quantity) || 0, surplus.quantity_unit || 'kg', 'kg', surplus.food_type);
    return stock.success && Math.min(stock.convertedQty, capacityKg - usedKg) > 0.001;
  });
}

// ── GET /api/network/overview ──────────────────────────────────────────────
router.get('/overview', (req, res) => {
  try {
    const activeSurplus = db.prepare(`
      SELECT COUNT(*) AS c FROM surplus_posts
      WHERE status IN ('available', 'partially_matched')
        AND COALESCE(remaining_quantity, quantity) > 0.001
        AND COALESCE(unsafe, 0) = 0
        AND remaining_usable_time IS NOT NULL
        AND julianday(remaining_usable_time) > julianday('now')
        AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = surplus_posts.donor_org_id AND o.status = 'active' AND o.verified = 1)
    `).get();
    const activeDemands = db.prepare(`
      SELECT COUNT(*) AS c FROM demand_registrations
      WHERE status IN ('open', 'partially_fulfilled')
        AND COALESCE(remaining_quantity, quantity_needed) > 0.001
        AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = demand_registrations.demand_org_id AND o.status = 'active' AND o.verified = 1)
    `).get();
    const activeRedist = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('pending','confirmed')").get();
    const recoveredTodayRows = completedMatchRows("AND date(m.completed_at) = date('now')");
    const demandRows = getDemandCompletionRows();
    const wasteRisksRaw = getWasteRiskRows(3.5);
    const wasteRiskCount = wasteRisksRaw.length;
    const fulfillmentRate = demandFulfillmentRate(demandRows);

    // Recent surplus for overview list
    const recentSurplusRaw = db.prepare(`
      SELECT sp.*, o.name as donor_name, o.location_address
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status IN ('available', 'partially_matched')
        AND o.status = 'active' AND o.verified = 1
        AND COALESCE(sp.remaining_quantity, sp.quantity) > 0.001
        AND COALESCE(sp.unsafe, 0) = 0
        AND sp.remaining_usable_time IS NOT NULL
        AND julianday(sp.remaining_usable_time) > julianday('now')
      ORDER BY sp.created_at DESC LIMIT 6
    `).all();

    const recentSurplus = recentSurplusRaw.map(s => ({
      id: s.id,
      title: s.food_name,
      foodType: s.food_type,
      donorName: s.donor_name,
      quantity: s.remaining_quantity != null ? s.remaining_quantity : s.quantity,
      originalQuantity: s.quantity,
      unit: s.quantity_unit,
      address: s.location_address,
      status: s.status,
      createdAt: s.created_at
    }));

    // Urgent demands for overview list
    const urgentDemandsRaw = db.prepare(`
      SELECT dr.*, o.name as org_name, o.location_address,
        COALESCE((SELECT SUM(m.allocated_quantity) FROM matches m
          WHERE m.demand_id = dr.id AND m.status = 'completed'), 0) AS completed_quantity
      FROM demand_registrations dr
      JOIN organizations o ON dr.demand_org_id = o.id
      WHERE dr.status IN ('open','partially_fulfilled')
        AND o.status = 'active' AND o.verified = 1
        AND COALESCE(dr.quantity_needed, 0) > COALESCE((SELECT SUM(m.allocated_quantity) FROM matches m
          WHERE m.demand_id = dr.id AND m.status = 'completed'), 0)
      ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END, dr.created_at DESC
      LIMIT 6
    `).all();

    const urgentDemands = urgentDemandsRaw.map(d => ({
      id: d.id,
      title: d.food_requirement,
      foodType: d.food_requirement,
      orgName: d.org_name,
      quantity: Math.max(0, Number(d.quantity_needed) - (Number(d.completed_quantity) || 0)),
      unit: d.quantity_unit,
      urgency: d.urgency,
      address: d.location_address,
      requiredBy: d.required_by,
      status: d.status,
      createdAt: d.created_at
    }));

    // Waste risks formatted
    const wasteRisks = wasteRisksRaw.map(r => ({
      id: r.id,
      foodType: r.food_name || r.food_type,
      donorName: r.donor_name,
      quantity: r.remaining_quantity,
      unit: r.quantity_unit,
      detail: `Unallocated safe surplus at risk — expires in ${formatTimeRemaining(r.hours_left)}.`,
      expiresIn: formatTimeRemaining(r.hours_left),
      severity: r.hours_left <= 2.0 ? 'high' : 'medium'
    }));

    res.json({
      activeSurplus: activeSurplus.c,
      activeDemands: activeDemands.c,
      activeRedistributions: activeRedist.c,
      fulfillmentRate,
      wasteRiskCount,
      foodRecoveredToday: formatUnitTotals(recoveredTodayRows, 'quantity', 'unit'),
      recentSurplus,
      urgentDemands,
      wasteRisks
    });
  } catch (err) {
    console.error('[Network/Overview Error]', err);
    res.status(500).json({ error: 'Failed to fetch network overview' });
  }
});

// ── GET /api/network/supply-demand ─────────────────────────────────────────
router.get('/supply-demand', (req, res) => {
  try {
    const surplusRaw = db.prepare(`
      SELECT sp.*, o.name as donor_name, o.location_address
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status != 'cancelled'
      ORDER BY sp.created_at DESC
    `).all();

    const demandsRaw = db.prepare(`
      SELECT dr.*, o.name as org_name, o.location_address
      FROM demand_registrations dr
      JOIN organizations o ON dr.demand_org_id = o.id
      WHERE dr.status != 'cancelled'
      ORDER BY dr.created_at DESC
    `).all();

    const surplus = surplusRaw.map(s => ({
      id: s.id,
      title: s.food_name,
      foodType: s.food_type,
      donorName: s.donor_name,
      quantity: s.remaining_quantity != null ? s.remaining_quantity : s.quantity,
      originalQuantity: s.quantity,
      unit: s.quantity_unit,
      address: s.location_address,
      status: s.status,
      reviewReason: s.review_reason || '',
      availableUntil: s.remaining_usable_time || null,
      matchId: s.status === 'matched' ? 'matched' : null,
      createdAt: s.created_at
    }));

    const demands = demandsRaw.map(d => ({
      id: d.id,
      title: d.food_requirement,
      foodType: d.food_requirement,
      orgName: d.org_name,
      quantity: d.quantity_needed,
      unit: d.quantity_unit,
      urgency: d.urgency,
      address: d.location_address,
      status: d.status,
      matchId: d.status === 'partially_fulfilled' || d.status === 'fulfilled' ? 'matched' : null,
      createdAt: d.created_at
    }));

    res.json({ surplus, demands });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch supply and demand' });
  }
});

// ── GET /api/network/redistributions ───────────────────────────────────────
router.get('/redistributions', (req, res) => {
  try {
    const matchesRaw = db.prepare(`
      SELECT m.*, COALESCE(sp.food_name, fi.food_name) as food_name,
        COALESCE(sp.food_type, fi.food_type) as food_type,
        COALESCE(sp.donor_org_id, fi.org_id) as source_org_id,
        do1.name as donor_name, do2.name as recipient_name,
        do1.location_lat as lat1, do1.location_lng as lng1,
        do2.location_lat as lat2, do2.location_lng as lng2
      FROM matches m
      LEFT JOIN surplus_posts sp ON m.surplus_id = sp.id
      LEFT JOIN food_bank_inventory fi ON m.source_inventory_id = fi.id
      LEFT JOIN organizations do1 ON do1.id = COALESCE(sp.donor_org_id, fi.org_id)
      LEFT JOIN organizations do2 ON m.demand_org_id = do2.id
      ORDER BY m.matched_at DESC LIMIT 50
    `).all();

    const redistributions = matchesRaw.map(m => {
      let dist = '3.5 km';
      if (m.lat1 && m.lat2) {
        const dLat = ((m.lat2 - m.lat1) * Math.PI) / 180;
        const dLng = ((m.lng2 - m.lng1) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((m.lat1 * Math.PI) / 180) * Math.cos((m.lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        dist = `${Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10} km`;
      }
      return {
        id: m.id,
        foodType: m.food_name || m.food_type,
        donorName: m.donor_name || 'Donor',
        recipientName: m.recipient_name || 'Central Reserve Hub',
        quantity: m.allocated_quantity,
        unit: m.allocated_unit,
        distance: dist,
        startedAt: m.matched_at,
        status: m.status
      };
    });

    res.json({ redistributions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch redistributions' });
  }
});

// ── GET /api/network/rebalancing ───────────────────────────────────────────
router.get('/rebalancing', (req, res) => {
  try {
    const allOrgs = db.prepare(`SELECT id, name, location_address FROM organizations`).all();
    
    // Group into logical areas
    const areaMap = {};
    allOrgs.forEach(o => {
      let area = 'Central City';
      const addr = (o.location_address || o.name || '').toLowerCase();
      if (addr.includes('indiranagar')) area = 'Indiranagar & East';
      else if (addr.includes('mg road') || addr.includes('central business') || addr.includes('cbd') || addr.includes('brigade')) area = 'Central Business District (CBD)';
      else if (addr.includes('koramangala')) area = 'Koramangala';
      else if (addr.includes('shanthi nagar') || addr.includes('richmond')) area = 'Shanthi Nagar & South';
      else if (addr.includes('shivajinagar') || addr.includes('cantonment')) area = 'Shivajinagar';
      else if (addr.includes('whitefield')) area = 'Whitefield Tech Belt';
      else if (addr.includes('btm')) area = 'BTM & South-East';
      else if (addr.includes('yeshwanthpur')) area = 'Yeshwanthpur Logistics';
      else if (addr.includes('ambala')) area = 'Ambala Cantt Hub';
      else area = o.location_address?.split(',')[0]?.trim() || o.name;

      if (!areaMap[area]) {
        areaMap[area] = { name: area, orgIds: [], supply: 0, demand: 0 };
      }
      areaMap[area].orgIds.push(o.id);
    });

    const activeSurplus = db.prepare(`
      SELECT donor_org_id, SUM(COALESCE(remaining_quantity, quantity)) as qty
      FROM surplus_posts
      WHERE status IN ('available', 'partially_matched', 'review_required')
        AND COALESCE(remaining_quantity, quantity) > 0
      GROUP BY donor_org_id
    `).all();

    const activeDemands = db.prepare(`
      SELECT demand_org_id, SUM(COALESCE(remaining_quantity, quantity_needed)) as qty
      FROM demand_registrations
      WHERE status IN ('open', 'partially_fulfilled')
        AND COALESCE(remaining_quantity, quantity_needed) > 0
      GROUP BY demand_org_id
    `).all();

    activeSurplus.forEach(s => {
      for (const area of Object.values(areaMap)) {
        if (area.orgIds.includes(s.donor_org_id)) {
          area.supply += Math.round(s.qty);
        }
      }
    });

    activeDemands.forEach(d => {
      for (const area of Object.values(areaMap)) {
        if (area.orgIds.includes(d.demand_org_id)) {
          area.demand += Math.round(d.qty);
        }
      }
    });

    const zones = Object.values(areaMap)
      .map(z => ({
        name: z.name,
        supply: z.supply,
        demand: z.demand,
        balance: z.supply - z.demand
      }))
      .sort((a, b) => b.balance - a.balance);

    const surplusZones = zones.filter(z => z.balance > 0);
    const deficitZones = zones.filter(z => z.balance < 0);
    const recommendations = [];

    if (surplusZones.length > 0 && deficitZones.length > 0) {
      surplusZones.slice(0, 2).forEach((sz, idx) => {
        const dz = deficitZones[idx % deficitZones.length];
        recommendations.push({
          id: `rec-real-${idx + 1}`,
          icon: '🔄',
          title: `Rebalance: Transfer from ${sz.name} to ${dz.name}`,
          detail: `${sz.name} has a net surplus of +${sz.balance} units while ${dz.name} has an unmet demand of ${Math.abs(dz.balance)} units. Cross-zone dispatch recommended.`,
          priority: Math.abs(dz.balance) > 30 ? 'high' : 'medium'
        });
      });
    }

    if (surplusZones.length > 0) {
      const topSurplus = surplusZones[0];
      recommendations.push({
        id: 'rec-buffer-1',
        icon: '🏦',
        title: `Buffer excess from ${topSurplus.name} to Central Reserve`,
        detail: `${topSurplus.name} has +${topSurplus.balance} surplus units available. Direct to Central Reserve Hub for perishable stabilization.`,
        priority: 'low'
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        id: 'rec-balanced',
        icon: '✅',
        title: 'Network Supply & Demand Balanced',
        detail: 'Current active food registrations are balanced across all monitored zones. No emergency cross-zone redistribution needed.',
        priority: 'low'
      });
    }

    res.json({ zones, recommendations });
  } catch (err) {
    console.error('Rebalancing error:', err);
    res.status(500).json({ error: 'Failed to fetch rebalancing data' });
  }
});

// ── GET /api/network/reserve ───────────────────────────────────────────────
router.get('/reserve', (req, res) => {
  try {
    const foodBanksRaw = db.prepare(`
      SELECT o.id, o.name, o.location_address, dp.storage_capacity
      FROM organizations o
      LEFT JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.type = 'food_bank' AND o.status = 'active' AND o.verified = 1
    `).all();

    const reservePoints = foodBanksRaw.map(fb => {
      const inventoryRows = db.prepare(`
        SELECT food_type, quantity_remaining, quantity_unit
        FROM food_bank_inventory WHERE org_id = ? AND quantity_remaining > 0
      `).all(fb.id);
      const incomingRows = db.prepare(`
        SELECT m.allocated_quantity, m.allocated_unit, COALESCE(sp.food_type, i.food_type, '') AS food_type
        FROM matches m
        LEFT JOIN surplus_posts sp ON m.source_type = 'surplus' AND sp.id = m.surplus_id
        LEFT JOIN food_bank_inventory i ON m.source_type = 'food_bank_inventory' AND i.id = m.source_inventory_id
        WHERE m.demand_org_id = ? AND m.status IN ('pending', 'confirmed')
      `).all(fb.id);
      const toKg = (quantity, unit, foodType) => {
        const converted = convertQuantity(Number(quantity) || 0, unit || 'kg', 'kg', foodType || '');
        return converted.success ? converted.convertedQty : null;
      };
      const stockKgValues = inventoryRows.map(row => toKg(row.quantity_remaining, row.quantity_unit, row.food_type));
      const incomingKgValues = incomingRows.map(row => toKg(row.allocated_quantity, row.allocated_unit, row.food_type));
      const unknownInventoryItems = stockKgValues.filter(value => value == null).length;
      const unknownIncomingItems = incomingKgValues.filter(value => value == null).length;
      const inventoryLoadKg = stockKgValues.reduce((sum, value) => sum + (value || 0), 0);
      const incomingLoadKg = incomingKgValues.reduce((sum, value) => sum + (value || 0), 0);
      const hasUnknownLoad = unknownInventoryItems + unknownIncomingItems > 0;
      const capacityKg = parseStorageCapacityKg(fb.storage_capacity);
      const currentLoadKg = hasUnknownLoad ? null : Math.round((inventoryLoadKg + incomingLoadKg) * 10) / 10;
      const availableKg = capacityKg != null && currentLoadKg != null
        ? Math.max(0, Math.round((capacityKg - currentLoadKg) * 10) / 10)
        : null;

      return {
        id: fb.id,
        name: fb.name,
        locationAddress: fb.location_address,
        capacityKg,
        currentLoadKg,
        inventoryLoadKg: Math.round(inventoryLoadKg * 10) / 10,
        incomingLoadKg: Math.round(incomingLoadKg * 10) / 10,
        availableKg,
        hasUnknownLoad,
        unknownInventoryItems,
        unknownIncomingItems,
        storageInfo: fb.storage_capacity || 'Storage details not declared',
        status: 'operational'
      };
    });

    const pendingReserve = db.prepare(`
      SELECT sp.*, o.name as donor_name,
             COALESCE(sp.remaining_quantity, sp.quantity) AS remaining_to_route
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE o.status = 'active' AND o.verified = 1
        AND sp.status IN ('available', 'partially_matched')
        AND COALESCE(sp.unsafe, 0) = 0
        AND COALESCE(sp.remaining_quantity, sp.quantity) > 0.001
        AND NOT EXISTS (
          SELECT 1 FROM matches m WHERE m.source_type = 'surplus' AND m.surplus_id = sp.id
            AND m.status IN ('pending', 'confirmed')
        )
        AND sp.remaining_usable_time IS NOT NULL
        AND julianday(sp.remaining_usable_time) > julianday('now')
        AND julianday(sp.remaining_usable_time) <= julianday('now') + (3.0 / 24.0)
      ORDER BY julianday(sp.remaining_usable_time) ASC
    `).all().filter(hasEligibleReserveReceiver).map(p => ({
      id: p.id,
      title: p.food_name,
      foodType: p.food_type,
      donorName: p.donor_name,
      quantity: p.remaining_to_route,
      unit: p.quantity_unit,
      address: p.pickup_address || '',
      availableUntil: p.remaining_usable_time,
      status: 'reserve_review'
    }));

    res.json({ reservePoints, pendingReserve });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reserve data' });
  }
});

// ── GET /api/network/community ─────────────────────────────────────────────
router.get('/community', (req, res) => {
  try {
    const supplyRows = db.prepare(`
      SELECT o.id AS org_id, o.name, o.location_address AS area,
             sp.id AS surplus_id, sp.food_name, sp.food_type,
             COALESCE(sp.remaining_quantity, sp.quantity) AS quantity,
             sp.quantity_unit AS unit
      FROM surplus_posts sp
      JOIN organizations o ON o.id = sp.donor_org_id
      WHERE o.status = 'active' AND o.verified = 1
        AND sp.status IN ('available', 'partially_matched')
        AND COALESCE(sp.remaining_quantity, sp.quantity) > 0.001
        AND COALESCE(sp.unsafe, 0) = 0
        AND sp.remaining_usable_time IS NOT NULL
        AND julianday(sp.remaining_usable_time) > julianday('now')
    `).all();
    const demandRows = getDemandCompletionRows().filter(row =>
      ['open', 'partially_fulfilled'].includes(row.status) &&
      Number(row.quantity_needed) > (Number(row.completed_quantity) || 0)
    );
    const demandOrgRows = new Map();
    const demandOrganizations = db.prepare(`
      SELECT id, name, location_address FROM organizations WHERE status = 'active' AND verified = 1
    `).all();
    const orgById = new Map(demandOrganizations.map(org => [org.id, org]));

    const supplyByOrg = new Map();
    for (const row of supplyRows) {
      if (!supplyByOrg.has(row.org_id)) supplyByOrg.set(row.org_id, { ...row, post_count: 0, quantities: [] });
      const group = supplyByOrg.get(row.org_id);
      group.post_count += 1;
      group.quantities.push({ quantity: row.quantity, unit: row.unit });
    }

    for (const row of demandRows) {
      if (!orgById.has(row.demand_org_id)) continue;
      if (!demandOrgRows.has(row.demand_org_id)) demandOrgRows.set(row.demand_org_id, { org: orgById.get(row.demand_org_id), requests: [] });
      demandOrgRows.get(row.demand_org_id).requests.push({
        ...row,
        remaining: Math.max(0, Number(row.quantity_needed) - (Number(row.completed_quantity) || 0))
      });
    }

    const formatArea = address => String(address || '').split(',')[0].trim();
    const surplusHotspots = [...supplyByOrg.values()]
      .sort((a, b) => b.post_count - a.post_count)
      .slice(0, 4)
      .map(org => ({
        area: formatArea(org.area) || org.name,
        orgName: org.name,
        orgId: org.org_id,
        post_count: org.post_count,
        detail: `${org.name} — ${org.post_count} active post${org.post_count === 1 ? '' : 's'} with ${formatUnitTotals(org.quantities, 'quantity', 'unit')} remaining.`,
        severity: org.post_count >= 3 ? 'high' : 'medium'
      }));

    const demandHotspots = [...demandOrgRows.entries()]
      .map(([orgId, entry]) => ({
        orgId,
        orgName: entry.org.name,
        area: formatArea(entry.org.location_address) || entry.org.name,
        requests: entry.requests,
        request_count: entry.requests.length,
        quantities: entry.requests.map(request => ({ quantity: request.remaining, unit: request.quantity_unit }))
      }))
      .sort((a, b) => b.request_count - a.request_count)
      .slice(0, 4)
      .map(org => ({
        ...org,
        detail: `${org.orgName} — ${org.request_count} open request${org.request_count === 1 ? '' : 's'} with ${formatUnitTotals(org.quantities, 'quantity', 'unit')} still unmet.`,
        severity: org.request_count >= 3 ? 'high' : 'medium'
      }));

    const accessGaps = demandRows
      .sort((a, b) => {
        const urgency = { emergency: 0, immediate: 1, regular: 2, planned: 3 };
        return (urgency[a.urgency] ?? 4) - (urgency[b.urgency] ?? 4) || String(a.id).localeCompare(String(b.id));
      })
      .slice(0, 5)
      .map(row => {
        const org = orgById.get(row.demand_org_id);
        const outstanding = Math.max(0, Number(row.quantity_needed) - (Number(row.completed_quantity) || 0));
        return {
          orgName: org?.name || 'Demand organisation',
          area: formatArea(org?.location_address) || org?.name || 'Area not recorded',
          detail: `${org?.name || 'A demand organisation'} still needs ${outstanding} ${row.quantity_unit || 'units'} of ${String(row.food_requirement || 'food').replace(/_/g, ' ')}; completed deliveries are deducted.`,
          severity: ['emergency', 'immediate'].includes(row.urgency) ? 'high' : 'medium'
        };
      });

    const availableTypes = supplyRows.map(row => ({ foodType: row.food_type, foodName: row.food_name }));
    const requirementGroups = new Map();
    demandRows.forEach(row => {
      const key = `${String(row.food_requirement || '').toLowerCase()}|${canonicalUnit(row.quantity_unit)}`;
      const outstanding = Math.max(0, Number(row.quantity_needed) - (Number(row.completed_quantity) || 0));
      const group = requirementGroups.get(key) || { food_requirement: row.food_requirement, quantity_unit: row.quantity_unit, needed: 0 };
      group.needed += outstanding;
      requirementGroups.set(key, group);
    });
    const mismatches = [...requirementGroups.values()]
      .filter(reqItem => !availableTypes.some(supply => isFoodAcceptedByProfile(supply.foodType, supply.foodName, [reqItem.food_requirement])))
      .map((reqItem, index) => ({
        id: `mis-${index + 1}`,
        foodRequirement: reqItem.food_requirement,
        title: `Unmet Need: ${String(reqItem.food_requirement || 'food').replace(/_/g, ' ')}`,
        detail: `${formatUnitTotals([{ quantity: reqItem.needed, unit: reqItem.quantity_unit }], 'quantity', 'unit')} remains unmet and no active in-date surplus with a compatible food type is listed.`,
        frequency: 'Current supply gap'
      }));

    res.json({ surplusHotspots, demandHotspots, accessGaps, mismatches });
  } catch (err) {
    console.error('Community intel error:', err);
    res.status(500).json({ error: 'Failed to fetch community intelligence' });
  }
});

// ── GET /api/network/waste-risk ────────────────────────────────────────────
router.get('/waste-risk', (req, res) => {
  try {
    const atRisk = getWasteRiskRows(3.5);

    const risks = atRisk.map(r => ({
      id: r.id,
      foodType: r.food_name || r.food_type,
      donorName: r.donor_name,
      quantity: r.remaining_quantity,
      unit: r.quantity_unit,
      detail: `Pickup at ${r.location_address || 'donor site'}. ${r.special_instructions || 'Needs match.'}`,
      expiresIn: formatTimeRemaining(r.hours_left),
      severity: r.hours_left <= 2.0 ? 'high' : 'medium',
      resolved: false
    }));

    res.json({ risks });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch waste risk' });
  }
});

// ── POST /api/network/surplus/:id/route ────────────────────────────────────
// Coordinator-triggered priority matching: eligible direct demands are tried
// first, followed by the existing food-bank fallback and safety review flow.
router.post('/surplus/:id/route', async (req, res) => {
  const surplusId = req.params.id;
  if (routingSurplusIds.has(surplusId)) {
    return res.status(409).json({ error: 'Routing is already running for this surplus. Refresh the queue shortly.' });
  }
  routingSurplusIds.add(surplusId);
  try {
    const surplus = db.prepare(`
      SELECT sp.*, o.status AS donor_status, o.verified AS donor_verified
      FROM surplus_posts sp JOIN organizations o ON o.id = sp.donor_org_id
      WHERE sp.id = ?
    `).get(surplusId);
    if (!surplus) return res.status(404).json({ error: 'Surplus post not found' });
    if (surplus.donor_status !== 'active' || !surplus.donor_verified) {
      return res.status(409).json({ error: 'Only active, verified donors can be routed' });
    }
    if (!['available', 'partially_matched'].includes(surplus.status) || Number(surplus.unsafe) === 1) {
      return res.status(409).json({ error: 'This surplus is no longer eligible for safe-food matching' });
    }
    const remaining = surplus.remaining_quantity == null ? Number(surplus.quantity) : Number(surplus.remaining_quantity);
    if (!(remaining > 0.001) || !surplus.remaining_usable_time ||
        Number(db.prepare("SELECT julianday(?) > julianday('now') AS valid").get(surplus.remaining_usable_time)?.valid) !== 1) {
      return res.status(409).json({ error: 'This surplus has no remaining safe quantity or is past its safe-until time' });
    }

    const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(surplus.donor_org_id);
    const candidates = db.prepare(`
      SELECT DISTINCT o.id, o.location_lat, o.location_lng
      FROM organizations o
      WHERE o.status = 'active' AND o.verified = 1 AND (
        EXISTS (
          SELECT 1 FROM demand_registrations d
          WHERE d.demand_org_id = o.id AND d.status IN ('open', 'partially_fulfilled')
            AND COALESCE(d.remaining_quantity, d.quantity_needed) > 0
        ) OR (o.type LIKE '%food_bank%' AND EXISTS (
          SELECT 1 FROM demand_org_profiles dp WHERE dp.org_id = o.id
        ))
      )
    `).all();
    const [routeResults, biogasRouteResults] = await Promise.all([
      precomputeRoutes(donorOrg, candidates),
      precomputeRoutesToBiogas(donorOrg)
    ]);

    // The matching service handles demand priority, food-bank capacity,
    // partner notifications, and fallback to biogas or coordinator review.
    const priorMatchIds = new Set(db.prepare('SELECT id FROM matches WHERE surplus_id = ?').all(surplusId).map(match => match.id));
    runUnifiedMatching({ surplusId, routeResults, biogasRouteResults });

    const offers = db.prepare(`
      SELECT m.id, m.allocated_quantity AS quantity, m.allocated_unit AS unit,
             m.status, o.name AS recipient_name
      FROM matches m JOIN organizations o ON o.id = m.demand_org_id
      WHERE m.surplus_id = ? ORDER BY m.matched_at DESC
    `).all(surplusId).filter(match => !priorMatchIds.has(match.id));
    const updated = db.prepare('SELECT status, remaining_quantity FROM surplus_posts WHERE id = ?').get(surplusId);
    res.json({ success: true, offers, status: updated?.status, remainingQuantity: updated?.remaining_quantity });
  } catch (err) {
    console.error('[Network/SurplusRoute]', err);
    res.status(500).json({ error: 'Could not route this surplus' });
  } finally {
    routingSurplusIds.delete(surplusId);
  }
});

// ── GET /api/network/interventions ─────────────────────────────────────────
router.get('/interventions', (req, res) => {
  try {
    const interventions = [];

    const urgentSurplus = db.prepare(`
      SELECT sp.*, o.name as donor_name, o.location_address
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status = 'available'
      ORDER BY sp.remaining_usable_time ASC LIMIT 3
    `).all();

    urgentSurplus.forEach((s) => {
      interventions.push({
        id: `int-surplus-${s.id}`,
        icon: '🚨',
        title: `Dispatch Expiring Surplus: ${s.food_name} (${s.quantity} ${s.quantity_unit})`,
        detail: `${s.donor_name} has ${s.quantity} ${s.quantity_unit} of ${s.food_name} available. Immediate match dispatch recommended to avoid landfill loss.`,
        priority: 'high'
      });
    });

    const urgentDemands = db.prepare(`
      SELECT dr.*, o.name as org_name
      FROM demand_registrations dr
      JOIN organizations o ON dr.demand_org_id = o.id
      WHERE dr.status IN ('open', 'partially_fulfilled')
      ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END, dr.created_at ASC
      LIMIT 3
    `).all();

    urgentDemands.forEach(d => {
      interventions.push({
        id: `int-demand-${d.id}`,
        icon: '⚖️',
        title: `Prioritize Demand: ${d.food_requirement} (${d.quantity_needed} ${d.quantity_unit})`,
        detail: `${d.org_name} has an active ${d.urgency} request for ${d.quantity_needed} ${d.quantity_unit}. Route nearest available supply or buffer reserve.`,
        priority: d.urgency === 'emergency' || d.urgency === 'immediate' ? 'high' : 'medium'
      });
    });

    const pendingMatches = db.prepare(`
      SELECT m.*, sp.food_name, do1.name as donor_name, do2.name as recipient_name
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      JOIN organizations do1 ON sp.donor_org_id = do1.id
      LEFT JOIN organizations do2 ON m.demand_org_id = do2.id
      WHERE m.status = 'pending'
      LIMIT 2
    `).all();

    pendingMatches.forEach(m => {
      interventions.push({
        id: `int-match-${m.id}`,
        icon: '🚚',
        title: `Confirm Match: ${m.food_name} → ${m.recipient_name || 'Recipient'}`,
        detail: `Automated match generated between ${m.donor_name} and ${m.recipient_name || 'Recipient'}. Verify transport coordinator and dispatch.`,
        priority: 'medium'
      });
    });

    const largeSurplus = db.prepare(`
      SELECT sp.*, o.name as donor_name
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.quantity >= 30 AND sp.status IN ('available', 'matched')
      LIMIT 1
    `).get();

    if (largeSurplus) {
      interventions.push({
        id: `int-bulk-${largeSurplus.id}`,
        icon: '📦',
        title: `Packaging Support: ${largeSurplus.donor_name} (${largeSurplus.quantity} ${largeSurplus.quantity_unit})`,
        detail: `Bulk donation of ${largeSurplus.food_name} requires portioning containers and thermal packing before last-mile delivery.`,
        priority: 'low'
      });
    }

    res.json({ interventions });
  } catch (err) {
    console.error('Interventions error:', err);
    res.status(500).json({ error: 'Failed to fetch interventions' });
  }
});

// ── GET /api/network/metrics ───────────────────────────────────────────────
router.get('/metrics', (req, res) => {
  try {
    const totalSurplusRows = db.prepare(`
      SELECT quantity, quantity_unit AS unit FROM surplus_posts WHERE status != 'cancelled'
    `).all();
    const demandRows = getDemandCompletionRows();
    const unmetRows = demandRows.filter(row => ['open', 'partially_fulfilled'].includes(row.status)).map(row => ({
      quantity: Math.max(0, (Number(row.quantity_needed) || 0) - (Number(row.completed_quantity) || 0)),
      unit: row.quantity_unit
    }));
    const completedRows = completedMatchRows();
    const recoveredMass = massEquivalentKg(completedRows);
    const sevenDayCompleted = completedMatchRows("AND date(m.completed_at) >= date('now', '-6 days')");
    const sevenDayExpiredRows = db.prepare(`
      SELECT COALESCE(remaining_quantity, quantity) AS quantity, quantity_unit AS unit
      FROM surplus_posts WHERE status = 'expired' AND date(updated_at) >= date('now', '-6 days')
    `).all();
    const matchCounts = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM matches WHERE date(matched_at) >= date('now', '-6 days')
    `).get();
    const matchCompletionRate = Number(matchCounts.total) > 0
      ? Math.round((Number(matchCounts.completed || 0) / Number(matchCounts.total)) * 100)
      : 0;

    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weeklyData = [];
    const wasteData = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = daysOfWeek[d.getDay()];

      const daySurplus = db.prepare(`
        SELECT COUNT(*) AS count FROM surplus_posts WHERE date(created_at) = ? AND status != 'cancelled'
      `).get(dateStr);
      const dayDemand = db.prepare(`
        SELECT COUNT(*) AS count FROM demand_registrations WHERE date(created_at) = ? AND status != 'cancelled'
      `).get(dateStr);
      const dayFulfilled = db.prepare(`
        SELECT COUNT(*) AS count FROM matches WHERE status = 'completed' AND date(completed_at) = ?
      `).get(dateStr);
      const dayExpired = db.prepare(`
        SELECT COUNT(*) AS count FROM surplus_posts WHERE status = 'expired' AND date(updated_at) = ?
      `).get(dateStr);

      weeklyData.push({
        day: dayName,
        date: dateStr,
        surplus: Number(daySurplus.count) || 0,
        demand: Number(dayDemand.count) || 0,
        fulfilled: Number(dayFulfilled.count) || 0
      });

      wasteData.push({
        day: dayName,
        date: dateStr,
        intercepted: Number(dayFulfilled.count) || 0,
        unintercepted: Number(dayExpired.count) || 0
      });
    }

    const co2Estimate = recoveredMass.kg > 0
      ? `~${Math.round(recoveredMass.kg * 2.5 * 10) / 10} kg CO₂e`
      : '0 kg CO₂e';

    res.json({
      totalSurplus: formatUnitTotals(totalSurplusRows, 'quantity', 'unit'),
      totalDemand: formatUnitTotals(demandRows.map(row => ({ quantity: row.quantity_needed, unit: row.quantity_unit })), 'quantity', 'unit'),
      foodRecovered: formatUnitTotals(completedRows, 'quantity', 'unit'),
      wastePrevented: recoveredMass.unconvertible > 0 ? `${co2Estimate} (mass-convertible only)` : co2Estimate,
      fulfillmentRate: demandFulfillmentRate(demandRows),
      unmetDemand: formatUnitTotals(unmetRows, 'quantity', 'unit'),
      matchCompletionRate,
      sevenDayRecovered: formatUnitTotals(sevenDayCompleted, 'quantity', 'unit'),
      sevenDayExpired: formatUnitTotals(sevenDayExpiredRows, 'quantity', 'unit'),
      weeklyData,
      wasteData
    });
  } catch (err) {
    console.error('Metrics error:', err);
    res.status(500).json({ error: 'Failed to fetch network metrics' });
  }
});

// Legacy backward-compatibility routes
router.get('/surplus', (req, res) => {
  const posts = db.prepare(`SELECT sp.*, o.name as donor_name FROM surplus_posts sp JOIN organizations o ON sp.donor_org_id = o.id WHERE sp.status != 'cancelled'`).all();
  res.json({ posts });
});

router.get('/demand', (req, res) => {
  const demands = db.prepare(`SELECT dr.*, o.name as org_name FROM demand_registrations dr JOIN organizations o ON dr.demand_org_id = o.id WHERE dr.status != 'cancelled'`).all();
  res.json({ demands });
});

// ── GET /api/network/map-data ─────────────────────────────────────────────
// Same as /api/admin/map-data but accessible to network roles.
router.get('/map-data', (req, res) => {
  try {
    const orgsRaw = db.prepare(`
      SELECT id, name, type, location_lat, location_lng, location_address, status, verified,
             COALESCE(map_verified, 0) as map_verified
      FROM organizations
      WHERE location_lat != 0 AND location_lng != 0
        AND status = 'active'
        AND verified = 1
      ORDER BY type
    `).all();

    const organizations = orgsRaw.map(o => ({
      id: o.id, name: o.name, type: o.type,
      lat: o.location_lat, lng: o.location_lng,
      address: o.location_address, status: o.status,
      verified: !!o.verified, mapVerified: !!o.map_verified
    }));

    const facilitiesRaw = db.prepare(`
      SELECT id, name, location_lat, location_lng, location_address, status, verified,
             accepted_waste_types, max_daily_intake_kg,
             COALESCE(is_available, 1) AS is_available,
             COALESCE(current_intake_kg, 0) AS current_intake_kg,
             operator_user_id
      FROM biogas_facilities
      WHERE location_lat != 0 AND location_lng != 0
        AND status = 'active'
        AND verified = 1
      ORDER BY name
    `).all();

    const biogas_facilities = facilitiesRaw.map(f => ({
      id: f.id, name: f.name,
      lat: f.location_lat, lng: f.location_lng,
      address: f.location_address, status: f.status,
      verified: !!f.verified,
      isAvailable: !!f.is_available,
      hasOperator: !!f.operator_user_id,
      currentIntakeKg: f.current_intake_kg,
      remainingCapacityKg: Math.max(0, (f.max_daily_intake_kg || 0) - (f.current_intake_kg || 0)),
      acceptedWasteTypes: (() => { try { return JSON.parse(f.accepted_waste_types || '[]'); } catch { return []; } })(),
      maxDailyIntakeKg: f.max_daily_intake_kg
    }));

    res.json({ organizations, biogas_facilities });
  } catch (err) {
    console.error('[Network/MapData]', err);
    res.status(500).json({ error: 'Failed to fetch map data' });
  }
});

// ── GET /api/network/route-preview ───────────────────────────────────────
router.get('/route-preview', async (req, res) => {
  try {
    const oLat = parseFloat(req.query.oLat);
    const oLng = parseFloat(req.query.oLng);
    const dLat = parseFloat(req.query.dLat);
    const dLng = parseFloat(req.query.dLng);
    if ([oLat, oLng, dLat, dLng].some(v => isNaN(v))) {
      return res.status(400).json({ error: 'oLat, oLng, dLat, dLng are required numeric query params' });
    }
    const { getRouteWithGeometry } = require('../services/routing');
    const result = await getRouteWithGeometry(oLat, oLng, dLat, dLng);
    res.json(result);
  } catch (err) {
    console.error('[Network/RoutePreview]', err);
    res.status(500).json({ error: 'Route preview unavailable' });
  }
});

// ── GET /api/network/overpass-bounds ─────────────────────────────────────
let lastNetworkOverpassMs = 0;
router.get('/overpass-bounds', async (req, res) => {
  try {
    const scope = (req.query.scope || 'area').toLowerCase();
    const south = parseFloat(req.query.south);
    const west  = parseFloat(req.query.west);
    const north = parseFloat(req.query.north);
    const east  = parseFloat(req.query.east);
    const type  = (req.query.type || 'biogas').toLowerCase();

    if (scope !== 'india' && [south, west, north, east].some(v => isNaN(v))) {
      return res.status(400).json({ error: 'south, west, north, east are required numeric params' });
    }
    if (scope !== 'india' && ((north - south) > 1 || (east - west) > 1)) {
      return res.status(400).json({ error: 'Bounding box too large — zoom in further before discovering' });
    }
    if (!['area', 'india'].includes(scope)) {
      return res.status(400).json({ error: 'scope must be area or india' });
    }
    const now = Date.now();
    if (now - lastNetworkOverpassMs < 2000) {
      return res.status(429).json({ error: 'Rate limit: one Overpass request per 2 seconds' });
    }
    lastNetworkOverpassMs = now;

    const bbox = `${south},${west},${north},${east}`;
    const areaSelector = 'area["ISO3166-1"="IN"][admin_level=2]->.india;';
    const within = scope === 'india' ? '(area.india)' : `(${bbox})`;
    let overpassQuery;
    if (type === 'biogas') {
      overpassQuery =
        `[out:json][timeout:${scope === 'india' ? 60 : 15}];` + (scope === 'india' ? areaSelector : '') +
        `(` +
        `  nwr["plant:method"="anaerobic_digestion"]${within};` +
        `  nwr["generator:method"="anaerobic_digestion"]${within};` +
        `  nwr["power"="plant"]["plant:source"="biogas"]${within};` +
        `  nwr["power"="plant"]["plant:source"="biomass"]["plant:method"="anaerobic_digestion"]${within};` +
        `  nwr["amenity"="biogas"]${within};` +
        `  nwr["industrial"="biogas_plant"]${within};` +
        `)out center;`;
    } else {
      overpassQuery =
        `[out:json][timeout:${scope === 'india' ? 60 : 15}];` + (scope === 'india' ? areaSelector : '') +
        `(` +
        `  nwr["amenity"="social_facility"]["social_facility"="food_bank"]${within};` +
        `  nwr["social_facility"="food_bank"]${within};` +
        `  nwr["amenity"="food_bank"]${within};` +
        `  nwr["social_facility"="soup_kitchen"]${within};` +
        `)out center;`;
    }

    const overpassBase = (process.env.OVERPASS_BASE_URL || 'https://overpass-api.de').replace(/\/$/, '');
    const url = `${overpassBase}/api/interpreter`;
    const postBody = `data=${encodeURIComponent(overpassQuery)}`;

    const osmData = await new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'FoodBridge/1.0 (food-waste-reduction)'
        }
      };
      const req2 = mod.request(options, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`Overpass HTTP ${response.statusCode}`));
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Overpass JSON parse error: ' + e.message)); }
        });
      });
      req2.setTimeout(scope === 'india' ? 65000 : 16000, () => { req2.destroy(); reject(new Error('Overpass request timed out')); });
      req2.on('error', reject);
      req2.write(postBody);
      req2.end();
    });

    const results = (osmData.elements || []).map(el => {
      const lat = el.type === 'node' ? el.lat : (el.center ? el.center.lat : null);
      const lng = el.type === 'node' ? el.lon : (el.center ? el.center.lon : null);
      if (!lat || !lng) return null;
      const tags = el.tags || {};
      return {
        osmId: el.id, osmType: el.type, lat, lng,
        name: tags.name || tags['name:en'] || (type === 'biogas' ? 'Unnamed Biogas Plant' : 'Unnamed Food Bank'),
        address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || null,
        phone: tags.phone || tags['contact:phone'] || null,
        email: tags.email || tags['contact:email'] || null,
        openingHours: tags.opening_hours || null,
        operator: tags.operator || null,
        source: 'openstreetmap_overpass',
        mapSourced: true, verified: false
      };
    }).filter(Boolean);

    res.json({ results, count: results.length, bbox: scope === 'india' ? null : bbox, scope, type });
  } catch (err) {
    console.error('[Network/OverpassBounds]', err);
    res.status(500).json({ error: 'Overpass discovery unavailable: ' + err.message });
  }
});

// ── GET /api/network/geocode-suggest ─────────────────────────────────────
let lastNetworkGeocodeSuggestMs = 0;
router.get('/geocode-suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    const now = Date.now();
    if (now - lastNetworkGeocodeSuggestMs < 1100) {
      return res.status(429).json({ error: 'Rate limit: one geocode request per second' });
    }
    lastNetworkGeocodeSuggestMs = now;

    const suggestions = await suggestLocations(q);
    res.json({ suggestions });
  } catch (err) {
    console.error('[Network/GeocodeSuggest]', err);
    res.status(500).json({ error: 'Geocoding service unavailable' });
  }
});

// ── POST /api/network/osm-import ─────────────────────────────────────────────
// Upsert an OSM-discovered biogas plant or food bank directly into the DB as
// an active facility.  Unknown capacity defaults to 0 (no gate on it for routing).
router.post('/osm-import', (req, res) => {
  try {
    const { osmId, osmType, name, lat, lng, address, phone, email, openingHours, operator, facilityType } = req.body;
    if (!name || lat == null || lng == null) {
      return res.status(400).json({ error: 'name, lat, and lng are required' });
    }

    // Idempotent: if this OSM element was already imported, return the existing record
    const existing = db.prepare(
      `SELECT id FROM biogas_facilities WHERE osm_id = ? AND osm_type = ?`
    ).get(String(osmId), osmType || 'node');

    if (existing) {
      return res.json({ success: true, id: existing.id, imported: false, message: 'Already in system' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO biogas_facilities
        (id, name, location_address, location_lat, location_lng,
         contact_phone, contact_email, operating_hours,
         accepted_waste_types, max_daily_intake_kg,
         status, notes, osm_id, osm_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
    `).run(
      id,
      name,
      address || '',
      lat,
      lng,
      phone || '',
      email || '',
      openingHours || '',
      JSON.stringify(['food_waste', 'organic']),
      `OSM-imported ${facilityType || 'biogas'} · operator: ${operator || 'unknown'}`,
      String(osmId || ''),
      osmType || 'node'
    );

    res.status(201).json({ success: true, id, imported: true });
  } catch (err) {
    console.error('[Network/OsmImport]', err);
    res.status(500).json({ error: 'Failed to import OSM facility: ' + err.message });
  }
});

module.exports = router;
