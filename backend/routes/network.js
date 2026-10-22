const express = require('express');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');

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
    const activeRedist = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('pending','confirmed','in_transit')").get();
    const totalDemand = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE status NOT IN ('cancelled')").get();
    const fulfilledDemand = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE status = 'fulfilled'").get();
    const recoveredToday = db.prepare("SELECT COALESCE(SUM(quantity), 0) as qty FROM surplus_posts WHERE status = 'completed' AND date(updated_at) = date('now')").get();

    // Waste risk count (available & expires within 3 hours)
    const wasteRisksRaw = db.prepare(`
      SELECT sp.*, o.name as donor_name,
        ROUND((julianday(sp.remaining_usable_time) - julianday('now')) * 24, 2) as hours_left
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
      quantity: s.quantity,
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
      quantity: s.quantity,
      unit: s.quantity_unit,
      address: s.location_address,
      status: s.status,
      matchId: s.status === 'matched' || s.status === 'in_transit' ? 'matched' : null,
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
      SELECT m.*, sp.food_name, sp.food_type, sp.quantity, sp.quantity_unit,
        do1.name as donor_name, do2.name as recipient_name,
        do1.location_lat as lat1, do1.location_lng as lng1,
        do2.location_lat as lat2, do2.location_lng as lng2
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      JOIN organizations do1 ON sp.donor_org_id = do1.id
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
        quantity: m.quantity,
        unit: m.quantity_unit,
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
      SELECT donor_org_id, SUM(quantity) as qty
      FROM surplus_posts
      WHERE status NOT IN ('cancelled', 'expired')
      GROUP BY donor_org_id
    `).all();

    const activeDemands = db.prepare(`
      SELECT demand_org_id, SUM(quantity_needed) as qty
      FROM demand_registrations
      WHERE status NOT IN ('cancelled', 'fulfilled')
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
      WHERE o.type = 'food_bank' OR o.name LIKE '%reserve%' OR o.name LIKE '%bank%'
    `).all();

    const reservePoints = foodBanksRaw.map(fb => {
      const currentLoadRaw = db.prepare(`
        SELECT COALESCE(SUM(sp.quantity), 0) as qty
        FROM matches m
        JOIN surplus_posts sp ON m.surplus_id = sp.id
        WHERE m.demand_org_id = ? AND m.status IN ('matched', 'in_transit', 'confirmed')
      `).get(fb.id);

      return {
        id: fb.id,
        name: fb.name,
        locationAddress: fb.location_address,
        capacity: fb.serving_capacity || 1500,
        currentLoad: Math.round(currentLoadRaw.qty || 0),
        storageInfo: fb.storage_capacity || 'Cold & Dry multi-zone storage facility',
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
      GROUP BY food_requirement
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
        ROUND((julianday(sp.remaining_usable_time) - julianday('now')) * 24, 2) as hours_left
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
    const recovered = db.prepare("SELECT COALESCE(SUM(quantity), 0) as q FROM surplus_posts WHERE status IN ('completed', 'in_transit', 'matched')").get();
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
        WHERE m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
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

module.exports = router;
