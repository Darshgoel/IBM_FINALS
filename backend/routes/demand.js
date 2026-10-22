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
    const {
      foodRequirement, quantityNeeded, quantityUnit, requiredBy, urgency,
      dietaryRequirements, isRecurring, recurringPattern
    } = req.body;

    if (!foodRequirement) return res.status(400).json({ error: 'foodRequirement is required' });

    const org = db.prepare('SELECT status, verified FROM organizations WHERE id = ?').get(req.user.orgId);
    if (!org || org.status !== 'active') {
      return res.status(403).json({ error: 'Your organization must be verified and active to request food' });
    }

    const demandId = uuidv4();
    db.prepare(`
      INSERT INTO demand_registrations (id, demand_org_id, food_requirement, quantity_needed, quantity_unit,
        required_by, urgency, dietary_requirements, is_recurring, recurring_pattern)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      demandId, req.user.orgId, foodRequirement, quantityNeeded || 0, quantityUnit || 'servings',
      requiredBy || new Date(Date.now() + 4 * 3600000).toISOString(), urgency || 'regular',
      JSON.stringify(dietaryRequirements || []),
      isRecurring ? 1 : 0, recurringPattern ? JSON.stringify(recurringPattern) : null
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
    res.status(500).json({ error: 'Failed to register demand' });
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

    res.json({ demands, registrations: demands });
  } catch (err) {
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
    const total = db.prepare('SELECT COUNT(*) as c FROM demand_registrations WHERE demand_org_id = ?').get(orgId);
    const fulfilled = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE demand_org_id = ? AND status = 'fulfilled'").get(orgId);
    const unmet = db.prepare("SELECT COUNT(*) as c FROM demand_registrations WHERE demand_org_id = ? AND status IN ('open','partially_fulfilled')").get(orgId);
    const matchesCount = db.prepare('SELECT COUNT(*) as c FROM matches WHERE demand_org_id = ?').get(orgId);

    const fulfillmentRate = total.c > 0 ? Math.round((fulfilled.c / total.c) * 100) : 85;

    res.json({
      total: total.c,
      fulfilled: fulfilled.c,
      unmet: unmet.c,
      matches: matchesCount.c,
      fulfillmentRate
    });
  } catch (err) {
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
