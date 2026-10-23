const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');
const { runUnifiedMatching, convertQuantity } = require('../services/matching');

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
      INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, remaining_quantity, quantity_unit,
        required_by, urgency, dietary_requirements, is_recurring, recurring_pattern, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(
      demandId, req.user.orgId, foodRequirement, quantityNeeded, quantityNeeded, quantityUnit,
      requiredBy, urgency, JSON.stringify(dietaryRequirements),
      isRecurring, recurringPattern ? JSON.stringify(recurringPattern) : null
    );

    // Call shared unified matcher (considers all valid candidates, hard gates & explainable ranking)
    const matchResult = runUnifiedMatching({ demandId });

    res.status(201).json({
      success: true,
      demandId,
      message: 'Demand registered successfully',
      matchResult
    });
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
      SELECT dr.*, m.id as match_id, m.status as match_status, m.allocated_quantity, m.allocated_unit,
             m.match_score, m.explanation as match_explanation, o.name as matched_donor_name, sp.food_name as matched_food_name
      FROM demand_registrations dr
      LEFT JOIN matches m ON dr.id = m.demand_id AND m.status != 'cancelled' AND m.status != 'declined'
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
      remainingQuantity: d.remaining_quantity != null ? d.remaining_quantity : d.quantity_needed,
      allocatedQuantity: d.allocated_quantity,
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
    const demand = db.prepare('SELECT * FROM demand_registrations WHERE id = ? AND demand_org_id = ?').get(req.params.id, req.user.orgId);
    if (!demand) return res.status(404).json({ error: 'Demand not found' });

    db.transaction(() => {
      // Find pending matches and release reserved surplus quantities
      const pendingMatches = db.prepare("SELECT * FROM matches WHERE demand_id = ? AND status = 'pending'").all(req.params.id);
      for (const m of pendingMatches) {
        db.prepare("UPDATE matches SET status = 'cancelled', notes = 'Demand was cancelled by recipient', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
        const alloc = m.allocated_quantity || 0;
        if (alloc > 0) {
          // allocated_quantity is stored in the demand's unit (allocated_unit).
          // The surplus post tracks its balance in its own unit. Convert before restoring.
          const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(m.surplus_id);
          if (surplus) {
            const conv = convertQuantity(alloc, m.allocated_unit || demand.quantity_unit, surplus.quantity_unit, surplus.food_type);
            const restoreInSurplusUnit = conv.success ? conv.convertedQty : alloc;
            db.prepare(`
              UPDATE surplus_posts
              SET remaining_quantity = MIN(quantity, remaining_quantity + ?),
                  status = 'available',
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(Math.round(restoreInSurplusUnit * 100) / 100, m.surplus_id);
          }
        } else {
          db.prepare("UPDATE surplus_posts SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.surplus_id);
        }
      }
      db.prepare("UPDATE demand_registrations SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    })();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel demand' });
  }
});

// ── GET Matches ────────────────────────────────────────────────────────────
router.get('/matches', (req, res) => {
  try {
    const rawMatches = db.prepare(`
      SELECT m.*, sp.food_name, sp.food_type, sp.quantity as surplus_total_quantity,
             sp.remaining_quantity as surplus_remaining_quantity, sp.quantity_unit as surplus_unit,
             sp.pickup_address, sp.remaining_usable_time, sp.special_instructions,
             o.name as donor_name, o.contact_phone as donor_phone, o.contact_email as donor_email,
             dr.urgency as demand_urgency, dr.quantity_needed, dr.remaining_quantity as demand_remaining_quantity,
             dr.quantity_unit as demand_unit
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      JOIN organizations o ON sp.donor_org_id = o.id
      LEFT JOIN demand_registrations dr ON m.demand_id = dr.id
      WHERE m.demand_org_id = ?
      ORDER BY m.matched_at DESC
    `).all(req.user.orgId);

    const matches = rawMatches.map(m => ({
      ...m,
      quantity: m.allocated_quantity != null ? m.allocated_quantity : m.surplus_total_quantity,
      unit: m.allocated_unit || m.demand_unit || m.surplus_unit || 'servings',
      donorName: m.donor_name,
      foodType: m.food_type,
      foodName: m.food_name,
      matchScore: m.match_score,
      availableUntil: m.remaining_usable_time,
      demandUrgency: m.demand_urgency || 'regular',
      explanation: m.explanation || m.notes
    }));

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// ── PUT Match Accept ───────────────────────────────────────────────────────
router.put('/matches/:id/accept', (req, res) => {
  try {
    const result = db.transaction(() => {
      // Re-read inside transaction and require status === 'pending' to prevent double-accepts
      const match = db.prepare('SELECT * FROM matches WHERE id = ? AND demand_org_id = ?').get(req.params.id, req.user.orgId);
      if (!match) return { status: 404, error: 'Match not found' };
      if (match.status !== 'pending') {
        return { status: 400, error: `Match cannot be accepted (current status: ${match.status})` };
      }

      db.prepare("UPDATE matches SET status = 'in_transit', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

      // Derive surplus post status from all its allocations, not just this one.
      // Only mark the whole post in_transit when every non-cancelled/declined match on it
      // is now in_transit (i.e. no remaining 'pending' allocations and remaining qty is 0).
      const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(match.surplus_id);
      if (surplus) {
        const pendingCount = db.prepare(
          "SELECT COUNT(*) as c FROM matches WHERE surplus_id = ? AND status = 'pending'"
        ).get(surplus.id).c;

        // Only flip the post to in_transit when there is no available remainder AND
        // no other pending allocation exists. If the post still has unallocated quantity
        // (remaining_quantity > 0) it should stay 'available' so new matches can form.
        const hasRemainder = (surplus.remaining_quantity == null ? surplus.quantity : surplus.remaining_quantity) > 0.001;
        if (!hasRemainder && pendingCount === 0) {
          db.prepare("UPDATE surplus_posts SET status = 'in_transit', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(surplus.id);
        }
        // else: leave the post status as-is (available / partially_matched) so the
        // unallocated remainder stays visible to the matching engine.

        return { donorOrgId: surplus.donor_org_id, foodName: surplus.food_name };
      }
      return {};
    })();

    if (result.status) return res.status(result.status).json({ error: result.error });

    if (result.donorOrgId) {
      dispatchNotification({
        orgId: result.donorOrgId,
        type: 'match',
        title: '🚚 Pickup Confirmed by Recipient',
        message: `Recipient has accepted and confirmed transfer of ${result.foodName}.`
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
    const result = db.transaction(() => {
      // Re-read inside transaction and require status === 'pending' to prevent invalid transitions
      const match = db.prepare('SELECT * FROM matches WHERE id = ? AND demand_org_id = ?').get(req.params.id, req.user.orgId);
      if (!match) return { status: 404, error: 'Match not found' };
      if (match.status !== 'pending') {
        return { status: 400, error: `Match cannot be declined (current status: ${match.status})` };
      }

      db.prepare("UPDATE matches SET status = 'declined', notes = 'Declined by recipient', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

      // Restore quantities using the correct units.
      // allocated_quantity is always stored in the demand's unit (allocated_unit).
      // The surplus post tracks its balance in its own unit (surplus_posts.quantity_unit).
      // We must convert before restoring.
      const allocQty = match.allocated_quantity || 0;
      if (allocQty > 0) {
        const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(match.surplus_id);
        if (surplus) {
          // Convert allocated (demand unit) → surplus unit for the surplus balance restore
          const conv = convertQuantity(allocQty, match.allocated_unit || 'servings', surplus.quantity_unit, surplus.food_type);
          const restoreInSurplusUnit = conv.success ? conv.convertedQty : allocQty;

          db.prepare(`
            UPDATE surplus_posts
            SET remaining_quantity = MIN(quantity, remaining_quantity + ?),
                status = 'available',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(Math.round(restoreInSurplusUnit * 100) / 100, match.surplus_id);
        }

        // Restore demand balance in the demand's own unit (no conversion needed)
        if (match.demand_id) {
          db.prepare(`
            UPDATE demand_registrations
            SET remaining_quantity = MIN(quantity_needed, remaining_quantity + ?),
                status = CASE WHEN remaining_quantity + ? >= quantity_needed THEN 'open' ELSE 'partially_fulfilled' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(allocQty, allocQty, match.demand_id);
        }
      }
      return {};
    })();

    if (result.status) return res.status(result.status).json({ error: result.error });

    res.json({ success: true, message: 'Match declined and reserved surplus restored to pool' });
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

    // People served calculation — use allocated_quantity from each match record,
    // which reflects only the portion actually committed, not the full surplus post total.
    const receivedFromMatches = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN m.allocated_unit = 'servings' THEN m.allocated_quantity
          WHEN m.allocated_unit = 'kg'       THEN m.allocated_quantity * 3.5
          WHEN m.allocated_unit = 'boxes'    THEN m.allocated_quantity * 10
          WHEN m.allocated_unit = 'liters'   THEN m.allocated_quantity * 2.5
          ELSE m.allocated_quantity * 3
        END
      ), 0) as people
      FROM matches m
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
    `).get(orgId);

    const peopleTotalServed = Math.round(receivedFromMatches.people || 0);

    // People served this month
    const thisMonthStart = new Date();
    const yyyy = thisMonthStart.getFullYear();
    const mm = String(thisMonthStart.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${yyyy}-${mm}`;

    const monthFromMatches = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN m.allocated_unit = 'servings' THEN m.allocated_quantity
          WHEN m.allocated_unit = 'kg'       THEN m.allocated_quantity * 3.5
          WHEN m.allocated_unit = 'boxes'    THEN m.allocated_quantity * 10
          WHEN m.allocated_unit = 'liters'   THEN m.allocated_quantity * 2.5
          ELSE m.allocated_quantity * 3
        END
      ), 0) as people
      FROM matches m
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
        AND (m.matched_at LIKE ? OR m.completed_at LIKE ?)
    `).get(orgId, `${monthPrefix}%`, `${monthPrefix}%`);

    const peopleServedMonth = Math.round(monthFromMatches.people || 0);

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
        SELECT COALESCE(SUM(m.allocated_quantity), 0) as qty, COUNT(*) as count
        FROM matches m
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
      SELECT sp.food_type as type, COUNT(*) as count,
             SUM(m.allocated_quantity) as quantity, m.allocated_unit as unit
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'in_transit', 'confirmed', 'matched')
      GROUP BY sp.food_type, m.allocated_unit
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
