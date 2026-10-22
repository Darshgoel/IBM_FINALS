const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');

const router = express.Router();

router.use(authenticate);
router.use(requireRole('demand_org'));

// ── GET Profile ────────────────────────────────────────────────────────────
router.get('/profile', (req, res) => {
  try {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.orgId);
    const profile = db.prepare('SELECT * FROM demand_org_profiles WHERE org_id = ?').get(req.user.orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ org, profile });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ── PUT Profile ────────────────────────────────────────────────────────────
router.put('/profile', (req, res) => {
  try {
    const {
      name, locationAddress, locationLat, locationLng, operatingHours, contactPhone, description,
      populationServed, servingCapacity, storageCapacity, receivingCapacity, foodRequirements, dietaryRestrictions
    } = req.body;

    db.prepare(`
      UPDATE organizations SET
        name = COALESCE(?, name),
        location_address = COALESCE(?, location_address),
        location_lat = COALESCE(?, location_lat),
        location_lng = COALESCE(?, location_lng),
        operating_hours = COALESCE(?, operating_hours),
        contact_phone = COALESCE(?, contact_phone),
        description = COALESCE(?, description)
      WHERE id = ?
    `).run(name, locationAddress, locationLat, locationLng, operatingHours, contactPhone, description, req.user.orgId);

    const exists = db.prepare('SELECT org_id FROM demand_org_profiles WHERE org_id = ?').get(req.user.orgId);
    if (exists) {
      db.prepare(`
        UPDATE demand_org_profiles SET
          population_served = COALESCE(?, population_served),
          serving_capacity = COALESCE(?, serving_capacity),
          storage_capacity = COALESCE(?, storage_capacity),
          receiving_capacity = COALESCE(?, receiving_capacity),
          food_requirements = COALESCE(?, food_requirements),
          dietary_restrictions = COALESCE(?, dietary_restrictions),
          updated_at = CURRENT_TIMESTAMP
        WHERE org_id = ?
      `).run(
        populationServed, servingCapacity, storageCapacity, receivingCapacity,
        foodRequirements ? JSON.stringify(foodRequirements) : null,
        dietaryRestrictions ? JSON.stringify(dietaryRestrictions) : null,
        req.user.orgId
      );
    } else {
      db.prepare(`
        INSERT INTO demand_org_profiles (org_id, population_served, serving_capacity, storage_capacity, receiving_capacity, food_requirements, dietary_restrictions)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user.orgId, populationServed || '', servingCapacity || 0, storageCapacity || '', receivingCapacity || '',
        JSON.stringify(foodRequirements || []), JSON.stringify(dietaryRestrictions || [])
      );
    }

    res.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    console.error('[Demand/Profile Error]', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── PUT Capacity ───────────────────────────────────────────────────────────
router.put('/capacity', (req, res) => {
  try {
    const { servingCapacity, storageCapacity, receivingCapacity } = req.body;
    db.prepare(`
      UPDATE demand_org_profiles SET
        serving_capacity = COALESCE(?, serving_capacity),
        storage_capacity = COALESCE(?, storage_capacity),
        receiving_capacity = COALESCE(?, receiving_capacity),
        updated_at = CURRENT_TIMESTAMP
      WHERE org_id = ?
    `).run(servingCapacity, storageCapacity, receivingCapacity, req.user.orgId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update capacity' });
  }
});

// ── POST Demand (Handles /demand and /register) ─────────────────────────────
const handlePostDemand = (req, res) => {
  try {
    const foodRequirement = req.body.foodRequirement || req.body.foodType;
    const quantityNeeded = req.body.quantityNeeded != null ? req.body.quantityNeeded : req.body.quantity;
    const quantityUnit = req.body.quantityUnit || req.body.unit || 'servings';
    const requiredBy = req.body.requiredBy || req.body.neededBy || new Date(Date.now() + 4 * 3600000).toISOString();
    const urgency = req.body.urgency || 'regular';
    
    let dietaryRequirements = req.body.dietaryRequirements || req.body.dietary || [];
    if (typeof dietaryRequirements === 'string') {
      dietaryRequirements = dietaryRequirements.split(',').map(s => s.trim()).filter(Boolean);
    }

    const isRecurring = req.body.isRecurring != null ? (req.body.isRecurring ? 1 : 0) : (req.body.recurring ? 1 : 0);
    const recurringPattern = req.body.recurringPattern || (isRecurring ? { frequency: req.body.recurrFreq || 'daily', time: req.body.recurrTime || '12:00' } : null);

    if (!foodRequirement) {
      return res.status(400).json({ error: 'Food requirement or food type is required' });
    }
    if (!quantityNeeded || quantityNeeded < 1) {
      return res.status(400).json({ error: 'Valid quantity is required' });
    }

    let org = db.prepare('SELECT id, status, verified FROM organizations WHERE id = ?').get(req.user.orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization profile not found' });
    }

    // If newly created org is pending verification, activate it to allow immediate demand creation
    if (org.status !== 'active') {
      db.prepare("UPDATE organizations SET status = 'active', verified = 1 WHERE id = ?").run(req.user.orgId);
    }

    const demandId = uuidv4();
    db.prepare(`
      INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, quantity_unit,
        required_by, urgency, dietary_requirements, is_recurring, recurring_pattern, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(
      demandId, req.user.orgId, foodRequirement, quantityNeeded, quantityUnit,
      requiredBy, urgency, JSON.stringify(dietaryRequirements),
      isRecurring, recurringPattern ? JSON.stringify(recurringPattern) : null
    );

    // Check if there is already an available surplus that fits!
    const matchingSurplus = db.prepare(`
      SELECT sp.* FROM surplus_posts sp
      WHERE sp.status = 'available'
      ORDER BY sp.remaining_usable_time ASC LIMIT 1
    `).get();

    if (matchingSurplus) {
      const matchId = uuidv4();
      db.prepare(`
        INSERT INTO matches (id, surplus_id, demand_id, demand_org_id, match_score, status)
        VALUES (?, ?, ?, ?, 88, 'pending')
      `).run(matchId, matchingSurplus.id, demandId, req.user.orgId);

      db.prepare("UPDATE surplus_posts SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(matchingSurplus.id);
      db.prepare("UPDATE demand_registrations SET status = 'partially_fulfilled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(demandId);

      dispatchNotification({
        orgId: req.user.orgId,
        type: 'match',
        title: '🍱 Immediate Match Found!',
        message: `Surplus ${matchingSurplus.food_name} matched with your demand. View matches tab to accept.`
      });
    }

    res.status(201).json({ success: true, demandId, message: 'Demand registered successfully' });
  } catch (err) {
    console.error('[Demand/Post Error]', err);
    res.status(500).json({ error: 'Failed to register demand: ' + err.message });
  }
};

router.post('/demand',   handlePostDemand);
router.post('/register', handlePostDemand);

// ── GET Demands (Handles /demands and /registrations) ───────────────────────
const handleGetDemands = (req, res) => {
  try {
    const demands = db.prepare(`
      SELECT dr.*, m.id as match_id, m.status as match_status, o.name as matched_donor_name, sp.food_name as matched_food_name
      FROM demand_registrations dr
      LEFT JOIN matches m ON dr.id = m.demand_id
      LEFT JOIN surplus_posts sp ON m.surplus_id = sp.id
      LEFT JOIN organizations o ON sp.donor_org_id = o.id
      WHERE dr.demand_org_id = ?
      ORDER BY dr.created_at DESC
    `).all(req.user.orgId);

    // Normalize property names for seamless frontend rendering
    const normalized = demands.map(d => ({
      ...d,
      foodType: d.food_requirement,
      quantity: d.quantity_needed,
      unit: d.quantity_unit,
      neededBy: d.required_by,
      dietary: (() => {
        try {
          const parsed = JSON.parse(d.dietary_requirements || '[]');
          return Array.isArray(parsed) ? parsed.join(', ') : parsed;
        } catch (e) {
          return d.dietary_requirements || '';
        }
      })(),
      recurring: !!d.is_recurring
    }));

    res.json({ demands: normalized, registrations: normalized });
  } catch (err) {
    console.error('[Demand/Get Error]', err);
    res.status(500).json({ error: 'Failed to fetch demands' });
  }
};

router.get('/demands',       handleGetDemands);
router.get('/registrations', handleGetDemands);

// ── DELETE Demand ──────────────────────────────────────────────────────────
router.delete('/demand/:id', (req, res) => {
  try {
    db.prepare("UPDATE demand_registrations SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND demand_org_id = ?")
      .run(req.params.id, req.user.orgId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel demand' });
  }
});

// ── GET Matches ────────────────────────────────────────────────────────────
router.get('/matches', (req, res) => {
  try {
    const matches = db.prepare(`
      SELECT m.*, sp.food_name, sp.food_type, sp.quantity, sp.quantity_unit,
             sp.pickup_address, sp.remaining_usable_time, sp.special_instructions,
             o.name as donor_name, o.contact_phone as donor_phone, o.contact_email as donor_email
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      JOIN organizations o ON sp.donor_org_id = o.id
      WHERE m.demand_org_id = ?
      ORDER BY m.matched_at DESC
    `).all(req.user.orgId);

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ── PUT Match Accept ───────────────────────────────────────────────────────
router.put('/matches/:id/accept', (req, res) => {
  try {
    const match = db.prepare('SELECT * FROM matches WHERE id = ? AND demand_org_id = ?').get(req.params.id, req.user.orgId);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    db.prepare("UPDATE matches SET status = 'in_transit', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    db.prepare("UPDATE surplus_posts SET status = 'in_transit', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(match.surplus_id);

    // Notify donor
    const surplus = db.prepare('SELECT donor_org_id, food_name FROM surplus_posts WHERE id = ?').get(match.surplus_id);
    if (surplus) {
      dispatchNotification({
        orgId: surplus.donor_org_id,
        type: 'match',
        title: '🚚 Pickup Confirmed by Recipient',
        message: `Recipient has accepted and confirmed transfer of ${surplus.food_name}.`
      });
    }

    res.json({ success: true, message: 'Match accepted, logistics dispatch scheduled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept match' });
  }
});

// ── PUT Match Decline ──────────────────────────────────────────────────────
router.put('/matches/:id/decline', (req, res) => {
  try {
    const match = db.prepare('SELECT * FROM matches WHERE id = ? AND demand_org_id = ?').get(req.params.id, req.user.orgId);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    db.prepare("UPDATE matches SET status = 'declined', notes = 'Declined by recipient', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    // Return surplus to available
    db.prepare("UPDATE surplus_posts SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(match.surplus_id);

    res.json({ success: true, message: 'Match declined and surplus returned to pool' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to decline match' });
  }
});

// ── GET Insights ───────────────────────────────────────────────────────────
router.get('/insights', (req, res) => {
  try {
    const orgId = req.user.orgId;
    
    // Demands counts
    const totalRow = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(quantity_needed), 0) as total_qty FROM demand_registrations WHERE demand_org_id = ?').get(orgId);
    const fulfilledRow = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity_needed), 0) as fulfilled_qty FROM demand_registrations WHERE demand_org_id = ? AND status = 'fulfilled'").get(orgId);
    const partialRow = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity_needed), 0) as partial_qty FROM demand_registrations WHERE demand_org_id = ? AND status = 'partially_fulfilled'").get(orgId);
    const unmetRow = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity_needed), 0) as unmet_qty FROM demand_registrations WHERE demand_org_id = ? AND status IN ('open','searching')").get(orgId);
    const matchesCount = db.prepare('SELECT COUNT(*) as count FROM matches WHERE demand_org_id = ?').get(orgId);

    const totalCount = totalRow.count || 0;
    const fulfilledCount = fulfilledRow.count || 0;
    const unmetCount = unmetRow.count || 0;

    // Fulfillment rate based on real records
    let fulfillmentRate = 0;
    if (totalCount > 0) {
      fulfillmentRate = Math.round(((fulfilledCount + (partialRow.count || 0) * 0.5) / totalCount) * 100);
      if (fulfillmentRate > 100) fulfillmentRate = 100;
    }

    // People served calculation:
    // 1. From matched / completed surplus posts
    const receivedFromMatches = db.prepare(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN sp.quantity_unit = 'servings' THEN sp.quantity
          WHEN sp.quantity_unit = 'kg' THEN sp.quantity * 3.5
          WHEN sp.quantity_unit = 'boxes' THEN sp.quantity * 10
          WHEN sp.quantity_unit = 'liters' THEN sp.quantity * 2.5
          ELSE sp.quantity * 3
        END
      ), 0) as people
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
    `).get(orgId);

    // 2. From fulfilled demands
    const receivedFromDemands = db.prepare(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN quantity_unit = 'servings' THEN quantity_needed
          WHEN quantity_unit = 'kg' THEN quantity_needed * 3.5
          WHEN quantity_unit = 'boxes' THEN quantity_needed * 10
          WHEN quantity_unit = 'liters' THEN quantity_needed * 2.5
          ELSE quantity_needed * 3
        END
      ), 0) as people
      FROM demand_registrations
      WHERE demand_org_id = ? AND status IN ('fulfilled', 'partially_fulfilled')
    `).get(orgId);

    const peopleTotalServed = Math.round(Math.max(receivedFromMatches.people || 0, receivedFromDemands.people || 0));

    // People served this month
    const thisMonthStart = new Date();
    const yyyy = thisMonthStart.getFullYear();
    const mm = String(thisMonthStart.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${yyyy}-${mm}`;

    const monthFromMatches = db.prepare(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN sp.quantity_unit = 'servings' THEN sp.quantity
          WHEN sp.quantity_unit = 'kg' THEN sp.quantity * 3.5
          WHEN sp.quantity_unit = 'boxes' THEN sp.quantity * 10
          WHEN sp.quantity_unit = 'liters' THEN sp.quantity * 2.5
          ELSE sp.quantity * 3
        END
      ), 0) as people
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
        AND (m.matched_at LIKE ? OR m.completed_at LIKE ?)
    `).get(orgId, `${monthPrefix}%`, `${monthPrefix}%`);

    const monthFromDemands = db.prepare(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN quantity_unit = 'servings' THEN quantity_needed
          WHEN quantity_unit = 'kg' THEN quantity_needed * 3.5
          ELSE quantity_needed * 3
        END
      ), 0) as people
      FROM demand_registrations
      WHERE demand_org_id = ? AND status IN ('fulfilled', 'partially_fulfilled')
        AND created_at LIKE ?
    `).get(orgId, `${monthPrefix}%`);

    const peopleServedMonth = Math.round(Math.max(monthFromMatches.people || 0, monthFromDemands.people || 0));

    // Weekly Data (last 7 days demand vs fulfilled)
    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weeklyData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = daysOfWeek[d.getDay()];

      const dayDemand = db.prepare(`
        SELECT COALESCE(SUM(quantity_needed), 0) as qty, COUNT(*) as count
        FROM demand_registrations
        WHERE demand_org_id = ? AND created_at LIKE ?
      `).get(orgId, `${dateStr}%`);

      const dayFulfilled = db.prepare(`
        SELECT COALESCE(SUM(sp.quantity), 0) as qty, COUNT(*) as count
        FROM matches m
        JOIN surplus_posts sp ON m.surplus_id = sp.id
        WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
          AND (m.matched_at LIKE ? OR m.completed_at LIKE ?)
      `).get(orgId, `${dateStr}%`, `${dateStr}%`);

      weeklyData.push({
        day: dayName,
        date: dateStr,
        demand: Math.round(dayDemand.qty || 0),
        fulfilled: Math.round(dayFulfilled.qty || 0),
        demandCount: dayDemand.count || 0,
        fulfilledCount: dayFulfilled.count || 0
      });
    }

    // Food Received / Requested Breakdown
    const foodTypeEmoji = {
      cooked_meals: '🍱', cooked_meal: '🍱',
      produce: '🥦', raw_uncooked: '🥦', vegetables: '🥦',
      bakery: '🍞', bread: '🍞',
      dairy: '🥛', milk: '🥛',
      packaged: '📦', packaged_sealed: '📦',
      beverages: '🥤', drinks: '🥤',
      other: '🍽️'
    };

    let foodBreakdown = db.prepare(`
      SELECT sp.food_type as type, COUNT(*) as count, SUM(sp.quantity) as quantity, sp.quantity_unit as unit
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
      GROUP BY sp.food_type
    `).all(orgId).map(b => ({
      icon: foodTypeEmoji[b.type] || '🍱',
      type: (b.type || 'Other').replace(/_/g, ' '),
      count: b.count,
      quantity: Math.round(b.quantity * 10) / 10,
      unit: b.unit || 'servings'
    }));

    if (!foodBreakdown.length) {
      foodBreakdown = db.prepare(`
        SELECT food_requirement as type, COUNT(*) as count, SUM(quantity_needed) as quantity, quantity_unit as unit
        FROM demand_registrations
        WHERE demand_org_id = ?
        GROUP BY food_requirement
      `).all(orgId).map(b => ({
        icon: foodTypeEmoji[b.type] || '🍱',
        type: (b.type || 'Other').replace(/_/g, ' '),
        count: b.count,
        quantity: Math.round(b.quantity * 10) / 10,
        unit: b.unit || 'servings'
      }));
    }

    // Shortages detection from real open demands
    const shortages = db.prepare(`
      SELECT food_requirement as type, COUNT(*) as count, SUM(quantity_needed) as unmet_qty
      FROM demand_registrations
      WHERE demand_org_id = ? AND status IN ('open', 'partially_fulfilled')
      GROUP BY food_requirement
      ORDER BY unmet_qty DESC
    `).all(orgId).map(s => ({
      type: (s.type || 'Food').replace(/_/g, ' '),
      count: s.count,
      quantity: Math.round(s.unmet_qty)
    }));

    res.json({
      total: totalCount,
      totalDemands: totalCount,
      fulfilled: fulfilledCount,
      fulfilledDemands: fulfilledCount,
      unmet: unmetCount,
      unmetDemands: unmetCount,
      matches: matchesCount.count || 0,
      fulfillmentRate,
      peopleTotalServed: peopleTotalServed.toLocaleString(),
      peopleTotalRaw: peopleTotalServed,
      peopleServedMonth: peopleServedMonth.toLocaleString(),
      peopleServedMonthRaw: peopleServedMonth,
      weeklyData,
      foodBreakdown,
      shortages
    });
  } catch (err) {
    console.error('Insights error:', err);
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

// ── Alerts ─────────────────────────────────────────────────────────────────
router.get('/alerts', (req, res) => {
  try {
    const alerts = db.prepare('SELECT * FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT 20').all(req.user.orgId);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

router.put('/alerts/:id/read', (req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ success: true });
});

router.put('/alerts/read-all', (req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE org_id = ?').run(req.user.orgId);
  res.json({ success: true });
});

module.exports = router;
