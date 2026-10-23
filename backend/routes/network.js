const express = require('express');
const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { suggestLocations } = require('../services/geocoding');
const { convertQuantity } = require('../services/matching');

const router = express.Router();

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

// ── GET /api/network/overview ──────────────────────────────────────────────
router.get('/overview', (req, res) => {
  try {
    const totalSurplus = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(quantity), 0) as qty FROM surplus_posts WHERE status NOT IN ('cancelled')").get();
    const activeSurplus = db.prepare("SELECT COUNT(*) as c FROM surplus_posts WHERE status = 'available'").get();
    const activeDemands = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE status IN ('open','partially_fulfilled')").get();
    const activeRedist = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('pending','confirmed')").get();
    const totalDemand = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE status NOT IN ('cancelled')").get();
    const fulfilledDemand = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE status = 'fulfilled'").get();
    const recoveredToday = db.prepare("SELECT COALESCE(SUM(quantity), 0) as qty FROM surplus_posts WHERE status = 'completed' AND date(updated_at) = date('now')").get();

    // Waste risk count (available & expires within 3 hours)
    const wasteRisksRaw = db.prepare(`
      SELECT sp.*, o.name as donor_name,
        ROUND(CAST((julianday(sp.remaining_usable_time) - julianday('now')) * 24 AS NUMERIC), 2) as hours_left
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status = 'available' AND sp.remaining_usable_time <= datetime('now', '+3.5 hours')
      ORDER BY sp.remaining_usable_time ASC
    `).all();

    const wasteRiskCount = wasteRisksRaw.length;
    const fulfillmentRate = totalDemand.c > 0 ? Math.round((fulfilledDemand.c / totalDemand.c) * 100) : (totalSurplus.c > 0 ? 100 : 0);

    // Recent surplus for overview list
    const recentSurplusRaw = db.prepare(`
      SELECT sp.*, o.name as donor_name, o.location_address
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status != 'cancelled'
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
      SELECT dr.*, o.name as org_name, o.location_address
      FROM demand_registrations dr
      JOIN organizations o ON dr.demand_org_id = o.id
      WHERE dr.status IN ('open','partially_fulfilled')
      ORDER BY CASE dr.urgency WHEN 'emergency' THEN 1 WHEN 'immediate' THEN 2 WHEN 'regular' THEN 3 ELSE 4 END, dr.created_at DESC
      LIMIT 6
    `).all();

    const urgentDemands = urgentDemandsRaw.map(d => ({
      id: d.id,
      title: d.food_requirement,
      foodType: d.food_requirement,
      orgName: d.org_name,
      quantity: d.quantity_needed,
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
      quantity: r.quantity,
      unit: r.quantity_unit,
      detail: `Surplus at risk — expires in ${formatTimeRemaining(r.hours_left)}. No match confirmed yet.`,
      expiresIn: formatTimeRemaining(r.hours_left),
      severity: r.hours_left <= 1.5 ? 'high' : 'medium'
    }));

    res.json({
      activeSurplus: activeSurplus.c,
      activeDemands: activeDemands.c,
      activeRedistributions: activeRedist.c,
      fulfillmentRate,
      wasteRiskCount,
      foodRecoveredToday: `${Math.round(recoveredToday.qty)} kg`,
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
      SELECT o.*, dp.serving_capacity, dp.storage_capacity
      FROM organizations o
      LEFT JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.type = 'food_bank' AND o.status = 'active' AND o.verified = 1
    `).all();

    const reservePoints = foodBanksRaw.map(fb => {
      // Inventory already received takes up reserve capacity. Add pending/accepted
      // allocations separately so promised deliveries reserve room before arrival.
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
      const toServings = (quantity, unit, foodType) => {
        const converted = convertQuantity(Number(quantity) || 0, unit || 'servings', 'servings', foodType || '');
        return converted.success ? converted.convertedQty : 0;
      };
      const stockServings = inventoryRows.reduce((sum, row) => sum + toServings(row.quantity_remaining, row.quantity_unit, row.food_type), 0);
      const incomingServings = incomingRows.reduce((sum, row) => sum + toServings(row.allocated_quantity, row.allocated_unit, row.food_type), 0);
      const currentLoad = Math.round((stockServings + incomingServings) * 10) / 10;

      return {
        id: fb.id,
        name: fb.name,
        locationAddress: fb.location_address,
        capacity: Number(fb.serving_capacity) > 0 ? Number(fb.serving_capacity) : null,
        currentLoad,
        inventoryLoad: Math.round(stockServings * 10) / 10,
        incomingLoad: Math.round(incomingServings * 10) / 10,
        storageInfo: fb.storage_capacity || 'Storage details not declared',
        status: 'operational'
      };
    });

    const pendingReserve = db.prepare(`
      SELECT sp.*, o.name as donor_name
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status = 'available' AND sp.remaining_usable_time <= datetime('now', '+3 hours')
    `).all().map(p => ({
      id: p.id,
      title: p.food_name,
      foodType: p.food_type,
      donorName: p.donor_name,
      quantity: p.quantity,
      unit: p.quantity_unit,
      address: p.pickup_address || p.location_address,
      status: 'pending_buffer'
    }));

    res.json({ reservePoints, pendingReserve });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reserve data' });
  }
});

// ── GET /api/network/community ─────────────────────────────────────────────
router.get('/community', (req, res) => {
  try {
    const topSurplus = db.prepare(`
      SELECT o.name, o.location_address as area, COUNT(*) as post_count, COALESCE(SUM(sp.quantity), 0) as total_qty
      FROM organizations o
      JOIN surplus_posts sp ON o.id = sp.donor_org_id
      WHERE sp.status != 'cancelled'
      GROUP BY o.id
      ORDER BY total_qty DESC LIMIT 4
    `).all();

    const surplusHotspots = topSurplus.map(s => ({
      area: s.area || s.name,
      detail: `${s.name} — ${s.post_count} surplus donations (${Math.round(s.total_qty * 10) / 10} kg registered)`,
      severity: s.total_qty > 50 ? 'high' : 'medium'
    }));

    const topDemand = db.prepare(`
      SELECT o.name, o.location_address as area, COUNT(*) as demand_count, COALESCE(SUM(dr.quantity_needed), 0) as total_qty
      FROM organizations o
      JOIN demand_registrations dr ON o.id = dr.demand_org_id
      WHERE dr.status != 'cancelled'
      GROUP BY o.id
      ORDER BY total_qty DESC LIMIT 4
    `).all();

    const demandHotspots = topDemand.map(d => ({
      area: d.area || d.name,
      detail: `${d.name} — ${d.demand_count} community requests (${Math.round(d.total_qty)} servings needed)`,
      severity: d.total_qty > 50 ? 'high' : 'medium'
    }));

    const unservedDemands = db.prepare(`
      SELECT dr.*, o.name as org_name, o.location_address as area
      FROM demand_registrations dr
      JOIN organizations o ON dr.demand_org_id = o.id
      WHERE dr.status = 'open'
      ORDER BY dr.created_at ASC LIMIT 3
    `).all();

    const accessGaps = unservedDemands.map(u => ({
      area: u.area || u.org_name,
      detail: `${u.org_name} has an unfulfilled request for ${u.quantity_needed} ${u.quantity_unit} of ${u.food_requirement.replace(/_/g, ' ')}. Requires donor connection.`,
      severity: u.urgency === 'emergency' || u.urgency === 'immediate' ? 'high' : 'medium'
    }));

    const mismatches = [];
    const openRequirements = db.prepare(`
      SELECT DISTINCT food_requirement, quantity_unit, SUM(quantity_needed) as needed
      FROM demand_registrations
      WHERE status IN ('open', 'partially_fulfilled')
      GROUP BY food_requirement, quantity_unit
    `).all();

    const availableTypes = db.prepare(`
      SELECT DISTINCT food_type
      FROM surplus_posts
      WHERE status = 'available'
    `).all().map(r => r.food_type);

    openRequirements.forEach(reqItem => {
      const isAvailable = availableTypes.some(t => t.toLowerCase() === reqItem.food_requirement.toLowerCase());
      if (!isAvailable) {
        mismatches.push({
          id: `mis-${mismatches.length + 1}`,
          title: `Unmet Need: ${reqItem.food_requirement.replace(/_/g, ' ')}`,
          detail: `Community demands ${Math.round(reqItem.needed)} ${reqItem.quantity_unit || 'servings'} of ${reqItem.food_requirement.replace(/_/g, ' ')}, but 0 matching available surplus exists in the donor network.`,
          frequency: 'Active deficit'
        });
      }
    });

    res.json({ surplusHotspots, demandHotspots, accessGaps, mismatches });
  } catch (err) {
    console.error('Community intel error:', err);
    res.status(500).json({ error: 'Failed to fetch community intelligence' });
  }
});

// ── GET /api/network/waste-risk ────────────────────────────────────────────
router.get('/waste-risk', (req, res) => {
  try {
    const atRisk = db.prepare(`
      SELECT sp.*, o.name as donor_name, o.location_address,
        ROUND(CAST((julianday(sp.remaining_usable_time) - julianday('now')) * 24 AS NUMERIC), 2) as hours_left
      FROM surplus_posts sp
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE sp.status = 'available'
      ORDER BY sp.remaining_usable_time ASC
    `).all();

    const risks = atRisk.map(r => ({
      id: r.id,
      foodType: r.food_name || r.food_type,
      donorName: r.donor_name,
      quantity: r.quantity,
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
    const totalSurplus = db.prepare("SELECT COALESCE(SUM(quantity), 0) as q FROM surplus_posts WHERE status != 'cancelled'").get();
    const totalDemand = db.prepare("SELECT COALESCE(SUM(quantity_needed), 0) as q FROM demand_registrations WHERE status != 'cancelled'").get();
    const recovered = db.prepare("SELECT COALESCE(SUM(quantity), 0) as q FROM surplus_posts WHERE status IN ('completed', 'confirmed', 'matched')").get();
    const openDemand = db.prepare("SELECT COALESCE(SUM(quantity_needed), 0) as q FROM demand_registrations WHERE status IN ('open','partially_fulfilled')").get();

    const totalSurplusQty = Math.round(totalSurplus.q * 10) / 10;
    const totalDemandQty = Math.round(totalDemand.q);
    const recoveredQty = Math.round(recovered.q * 10) / 10;
    const openDemandQty = Math.round(openDemand.q);

    const fulfillmentRate = totalDemandQty > 0 ? Math.round(((totalDemandQty - openDemandQty) / totalDemandQty) * 100) : (totalSurplusQty > 0 ? 100 : 0);

    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weeklyData = [];
    const wasteData = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = daysOfWeek[d.getDay()];

      const daySurplus = db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as qty FROM surplus_posts WHERE created_at LIKE ? AND status != 'cancelled'
      `).get(`${dateStr}%`);

      const dayDemand = db.prepare(`
        SELECT COALESCE(SUM(quantity_needed), 0) as qty FROM demand_registrations WHERE created_at LIKE ? AND status != 'cancelled'
      `).get(`${dateStr}%`);

      const dayFulfilled = db.prepare(`
        SELECT COALESCE(SUM(sp.quantity), 0) as qty
        FROM matches m
        JOIN surplus_posts sp ON m.surplus_id = sp.id
        WHERE m.status IN ('completed', 'confirmed', 'matched')
          AND (m.matched_at LIKE ? OR m.completed_at LIKE ?)
      `).get(`${dateStr}%`, `${dateStr}%`);

      const dayExpired = db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as qty FROM surplus_posts WHERE status = 'expired' AND updated_at LIKE ?
      `).get(`${dateStr}%`);

      weeklyData.push({
        day: dayName,
        date: dateStr,
        surplus: Math.round(daySurplus.qty || 0),
        demand: Math.round(dayDemand.qty || 0),
        fulfilled: Math.round(dayFulfilled.qty || 0)
      });

      wasteData.push({
        day: dayName,
        date: dateStr,
        intercepted: Math.round(dayFulfilled.qty || 0),
        unintercepted: Math.round(dayExpired.qty || 0)
      });
    }

    res.json({
      totalSurplus: `${totalSurplusQty} kg`,
      totalDemand: `${totalDemandQty} servings`,
      foodRecovered: `${recoveredQty} kg`,
      wastePrevented: `${Math.round(recoveredQty * 2.5 * 10) / 10} kg CO₂e`,
      fulfillmentRate,
      unmetDemand: `${openDemandQty} servings`,
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
