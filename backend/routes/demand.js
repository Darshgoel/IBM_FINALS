const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');
const { runUnifiedMatching, precomputeRoutes, convertQuantity, matchOpenDemandsForInventory } = require('../services/matching');

const router = express.Router();

function expiryValueForInventory(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const normalized = raw.includes('T')
    ? (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}+05:30`)
    : raw.replace(' ', 'T') + '+05:30';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function expiryTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T23:59:59.999+05:30`).getTime();
  const normalized = raw.includes('T')
    ? (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}+05:30`)
    : raw.replace(' ', 'T') + '+05:30';
  const timestamp = new Date(normalized).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function addFoodBankReceiptAllowance(value) {
  const baseTimestamp = expiryTimestamp(value);
  return baseTimestamp == null ? null : new Date(baseTimestamp + 3 * 60 * 60 * 1000).toISOString();
}

function normalizeRequiredBy(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const endOfIndiaDay = new Date(`${raw}T23:59:59.999+05:30`);
    return Number.isNaN(endOfIndiaDay.getTime()) ? null : endOfIndiaDay.toISOString();
  }
  const normalized = raw.includes('T')
    ? (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}+05:30`)
    : raw.replace(' ', 'T') + '+05:30';
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

router.use(authenticate);
router.use(requireRole('demand_org', 'food_bank'));

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
    const { servingCapacity, storageCapacity, receivingCapacity, receivingCapacityKg } = req.body;
    // receivingCapacityKg (numeric kg) is stored in receiving_capacity_kg; the
    // legacy receivingCapacity (string label) maps to receiving_capacity.
    db.prepare(`
      UPDATE demand_org_profiles SET
        serving_capacity = COALESCE(?, serving_capacity),
        storage_capacity = COALESCE(?, storage_capacity),
        receiving_capacity = COALESCE(?, receiving_capacity),
        receiving_capacity_kg = COALESCE(?, receiving_capacity_kg),
        updated_at = CURRENT_TIMESTAMP
      WHERE org_id = ?
    `).run(
      servingCapacity ?? null,
      storageCapacity ?? null,
      receivingCapacity ?? null,
      receivingCapacityKg ?? null,
      req.user.orgId
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update capacity' });
  }
});

// ── POST Demand (Handles /demand and /register) ─────────────────────────────
const handlePostDemand = async (req, res) => {
  try {
    const foodRequirement = req.body.foodRequirement || req.body.foodType;
    const quantityNeeded = req.body.quantityNeeded != null ? req.body.quantityNeeded : req.body.quantity;
    const quantityUnit = req.body.quantityUnit || req.body.unit || 'servings';
    const rawRequiredBy = req.body.requiredBy || req.body.neededBy;
    const requiredBy = rawRequiredBy
      ? normalizeRequiredBy(rawRequiredBy)
      : new Date(Date.now() + 4 * 3600000).toISOString();
    if (rawRequiredBy && !requiredBy) {
      return res.status(400).json({ error: 'Enter a valid required-by date and time' });
    }
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

    if (org.status !== 'active' || !org.verified) {
      return res.status(403).json({ error: 'Your organization must be approved and active before registering demand' });
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

    // Pre-compute routes from all active donor orgs to this demand org before sync transaction
    const demandOrgData = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.orgId);
    const candidateDonorOrgs = db.prepare(`
      SELECT DISTINCT o.id, o.location_lat, o.location_lng FROM organizations o
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
    const routeResults = await precomputeRoutes(demandOrgData, candidateDonorOrgs);

    // Call shared unified matcher (considers all valid candidates, hard gates & explainable ranking)
    const matchResult = runUnifiedMatching({ demandId, routeResults });

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
             m.match_score, m.explanation as match_explanation,
             COALESCE(o.name, io.name) as matched_donor_name,
             COALESCE(sp.food_name, fi.food_name) as matched_food_name,
             m.source_type
      FROM demand_registrations dr
      LEFT JOIN matches m ON dr.id = m.demand_id AND m.status != 'cancelled' AND m.status != 'declined'
      LEFT JOIN surplus_posts sp ON m.source_type = 'surplus' AND m.surplus_id = sp.id
      LEFT JOIN organizations o ON sp.donor_org_id = o.id
      LEFT JOIN food_bank_inventory fi ON m.source_type = 'food_bank_inventory' AND m.source_inventory_id = fi.id
      LEFT JOIN organizations io ON fi.org_id = io.id
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
    const committedMatch = db.prepare(`
      SELECT 1 FROM matches WHERE demand_id = ? AND status IN ('confirmed', 'completed', 'matched') LIMIT 1
    `).get(req.params.id);
    if (committedMatch) {
      return res.status(409).json({ error: 'This demand has an accepted or completed food handover and can no longer be cancelled here.' });
    }

    db.transaction(() => {
      // Find pending matches and release reserved surplus quantities
      const pendingMatches = db.prepare("SELECT * FROM matches WHERE demand_id = ? AND status = 'pending'").all(req.params.id);
      for (const m of pendingMatches) {
        db.prepare("UPDATE matches SET status = 'cancelled', notes = 'Demand was cancelled by recipient', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
        const alloc = m.allocated_quantity || 0;
        if (alloc > 0) {
          // allocated_quantity is stored in the demand's unit (allocated_unit).
          // The surplus post tracks its balance in its own unit. Convert before restoring.
          const surplus = m.source_type === 'food_bank_inventory'
            ? db.prepare('SELECT * FROM food_bank_inventory WHERE id = ? AND org_id != ?').get(m.source_inventory_id, req.user.orgId)
            : db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(m.surplus_id);
          if (surplus && m.source_type === 'food_bank_inventory') {
            const conv = convertQuantity(alloc, m.allocated_unit || demand.quantity_unit, surplus.quantity_unit, surplus.food_type);
            const restore = conv.success ? conv.convertedQty : alloc;
            db.prepare(`UPDATE food_bank_inventory SET quantity_remaining = MIN(quantity_received, quantity_remaining + ?) WHERE id = ?`)
              .run(Math.round(restore * 100) / 100, surplus.id);
          } else if (surplus) {
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
          if (m.source_type !== 'food_bank_inventory') {
            db.prepare("UPDATE surplus_posts SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.surplus_id);
          }
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
      SELECT m.*, COALESCE(sp.food_name, fi.food_name) as food_name,
             COALESCE(sp.food_type, fi.food_type) as food_type, sp.quantity as surplus_total_quantity,
             sp.remaining_quantity as surplus_remaining_quantity, sp.quantity_unit as surplus_unit,
             sp.pickup_address, sp.remaining_usable_time, sp.special_instructions,
             COALESCE(o.name, io.name) as donor_name, COALESCE(o.contact_phone, io.contact_phone) as donor_phone,
             COALESCE(o.contact_email, io.contact_email) as donor_email,
             fi.quantity_received as inventory_total_quantity, fi.quantity_remaining as inventory_remaining_quantity,
             fi.quantity_unit as inventory_unit, fi.expiry_date as inventory_expiry_date,
             dr.urgency as demand_urgency, dr.quantity_needed, dr.remaining_quantity as demand_remaining_quantity,
             dr.quantity_unit as demand_unit,
             m.route_distance_km, m.route_duration_minutes, m.route_provider
      FROM matches m
      LEFT JOIN surplus_posts sp ON m.source_type = 'surplus' AND m.surplus_id = sp.id
      LEFT JOIN organizations o ON sp.donor_org_id = o.id
      LEFT JOIN food_bank_inventory fi ON m.source_type = 'food_bank_inventory' AND m.source_inventory_id = fi.id
      LEFT JOIN organizations io ON fi.org_id = io.id
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
      availableUntil: m.remaining_usable_time || m.inventory_expiry_date,
      demandUrgency: m.demand_urgency || 'regular',
      explanation: m.explanation || m.notes
    }));

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

// Outgoing inventory allocations are tracking-only for the supplying food bank.
router.get('/inventory-matches', (req, res) => {
  try {
    const matches = db.prepare(`
      SELECT m.*, i.food_name, i.food_type, i.quantity_unit AS inventory_unit,
             i.expiry_date AS inventory_expiry_date,
             recipient.name AS recipient_name, recipient.location_address AS recipient_address
      FROM matches m
      JOIN food_bank_inventory i ON m.source_inventory_id = i.id
      LEFT JOIN organizations recipient ON m.demand_org_id = recipient.id
      WHERE m.source_type = 'food_bank_inventory' AND i.org_id = ?
      ORDER BY m.matched_at DESC
    `).all(req.user.orgId);
    res.json({ matches: matches.map(m => ({ ...m, direction: 'outgoing' })) });
  } catch (err) {
    console.error('[Demand/Inventory matches]', err);
    res.status(500).json({ error: 'Failed to fetch inventory redistributions' });
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

      // Acceptance confirms the partner will collect; receipt remains a separate
      // confirmation step. No intermediate transit status is recorded.
      const source = match.source_type === 'food_bank_inventory'
        ? db.prepare('SELECT * FROM food_bank_inventory WHERE id = ?').get(match.source_inventory_id)
        : db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(match.surplus_id);
      if (match.source_type === 'food_bank_inventory' && source) {
        const expiry = expiryTimestamp(source.expiry_date);
        if (!expiry || expiry <= Date.now()) {
          return { status: 409, error: 'This food-bank inventory has expired and cannot be accepted' };
        }
      }
      if (match.source_type === 'food_bank_inventory' && !source) {
        return { status: 409, error: 'The matched food-bank inventory is no longer available' };
      }
      db.prepare("UPDATE matches SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
      const surplus = match.source_type === 'food_bank_inventory' ? null : source;
      if (surplus) {
        const pendingCount = db.prepare(
          "SELECT COUNT(*) as c FROM matches WHERE surplus_id = ? AND status = 'pending'"
        ).get(surplus.id).c;

        // Keep fully allocated posts matched; accepted allocations remain distinct
        // from completed receipts. Preserve any genuine unallocated remainder.
        const hasRemainder = (surplus.remaining_quantity == null ? surplus.quantity : surplus.remaining_quantity) > 0.001;
        if (!hasRemainder && pendingCount === 0) {
          db.prepare("UPDATE surplus_posts SET status = 'matched', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(surplus.id);
        }
        // else: leave the post status as-is (available / partially_matched) so the
        // unallocated remainder stays visible to the matching engine.

      return { donorOrgId: surplus.donor_org_id, foodName: surplus.food_name };
      }
      if (source && match.source_type === 'food_bank_inventory') {
        const sourceOrg = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(source.org_id);
        return { donorOrgId: source.org_id, donorName: sourceOrg?.name, foodName: source.food_name };
      }
      return {};
    })();

    if (result.status) return res.status(result.status).json({ error: result.error });

    if (result.donorOrgId) {
      dispatchNotification({
        orgId: result.donorOrgId,
        type: 'match',
        title: '🚚 Pickup Confirmed by Recipient',
        message: `Recipient accepted the match for ${result.foodName}; receipt confirmation is still pending.`
      });
    }

    res.json({ success: true, message: 'Match accepted, logistics dispatch scheduled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept match' });
  }
});

// ── PUT Match Decline ──────────────────────────────────────────────────────
router.put('/matches/:id/decline', async (req, res) => {
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
        const isInventory = match.source_type === 'food_bank_inventory';
        const surplus = isInventory
          ? db.prepare('SELECT * FROM food_bank_inventory WHERE id = ?').get(match.source_inventory_id)
          : db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(match.surplus_id);
        if (surplus && isInventory) {
          const conv = convertQuantity(allocQty, match.allocated_unit || 'servings', surplus.quantity_unit, surplus.food_type);
          const restore = conv.success ? conv.convertedQty : allocQty;
          db.prepare(`UPDATE food_bank_inventory SET quantity_remaining = MIN(quantity_received, quantity_remaining + ?) WHERE id = ?`)
            .run(Math.round(restore * 100) / 100, surplus.id);
        } else if (surplus) {
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

    try {
      await matchOpenDemandsForInventory();
      // Food-bank fallback offers have no demand_id. Re-run donor-side routing
      // after a decline so remaining surplus can be offered to another bank
      // with capacity (or to a newly eligible direct demand).
      const declinedMatch = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
      if (declinedMatch?.notes === 'fallback_food_bank' && declinedMatch.surplus_id) {
        runUnifiedMatching({ surplusId: declinedMatch.surplus_id });
      }
    } catch (matchErr) { console.error('[Demand/Decline rematching]', matchErr); }

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
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'confirmed', 'matched')
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
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'confirmed', 'matched')
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
        WHERE m.demand_org_id = ? AND m.status IN ('completed', 'confirmed', 'matched')
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
      WHERE m.demand_org_id = ? AND m.status IN ('completed', 'confirmed', 'matched')
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

// ── Food-bank inventory ────────────────────────────────────────────────────
// GET /api/demand-org/inventory
router.get('/inventory', authenticate, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM food_bank_inventory
      WHERE org_id = ? AND COALESCE(quantity_remaining, 0) > 0
      ORDER BY received_at DESC
      LIMIT 200
    `).all(req.user.orgId);
    res.json(rows);
  } catch (err) {
    console.error('[Demand/Inventory GET]', err);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

// POST /api/demand-org/inventory
router.post('/inventory', authenticate, async (req, res) => {
  try {
    const { matchId, foodName, foodType, quantityReceived, quantityUnit, expiryDate, storageLocation, notes, dietaryTags } = req.body;
    const qty = Number(quantityReceived);
    if (!foodName || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Food name and a quantity greater than zero are required' });
    }
    const expiryMs = expiryTimestamp(expiryDate);
    if (expiryMs == null) return res.status(400).json({ error: 'A valid expiry date is required before stock can be matched' });
    if (expiryMs <= Date.now()) return res.status(400).json({ error: 'Expired stock cannot be added as available inventory' });
    const id = uuidv4();
    const tags = Array.isArray(dietaryTags)
      ? dietaryTags
      : (typeof dietaryTags === 'string' ? dietaryTags.split(/[,;]/) : []);
    db.prepare(`
      INSERT INTO food_bank_inventory
        (id, org_id, match_id, food_name, food_type, dietary_tags, quantity_received, quantity_unit, quantity_remaining, expiry_date, storage_location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.orgId, matchId || null, foodName, foodType || '', JSON.stringify(tags.map(tag => String(tag).trim()).filter(Boolean)), qty, quantityUnit || 'kg', qty, expiryDate || null, storageLocation || '', notes || '');
    let matchingTriggered = false;
    if (expiryDate && new Date(`${String(expiryDate).slice(0, 10)}T23:59:59.999+05:30`).getTime() > Date.now()) {
      try { await matchOpenDemandsForInventory(); matchingTriggered = true; }
      catch (matchErr) { console.error('[Demand/Inventory matching]', matchErr); }
    }
    res.status(201).json({ id, success: true, matchingTriggered });
  } catch (err) {
    console.error('[Demand/Inventory POST]', err);
    res.status(500).json({ error: 'Failed to add inventory item' });
  }
});

// PUT /api/demand-org/inventory/:id — update remaining quantity
router.put('/inventory/:id', authenticate, async (req, res) => {
  try {
    const { quantityRemaining, storageLocation, notes, dietaryTags, expiryDate } = req.body;
    if (quantityRemaining != null) {
      const requested = Number(quantityRemaining);
      const item = db.prepare('SELECT quantity_received FROM food_bank_inventory WHERE id = ? AND org_id = ?').get(req.params.id, req.user.orgId);
      if (!item) return res.status(404).json({ error: 'Inventory item not found' });
      if (!Number.isFinite(requested) || requested < 0 || requested > Number(item.quantity_received)) {
        return res.status(400).json({ error: `Remaining quantity must be between 0 and ${item.quantity_received}` });
      }
    }
    if (expiryDate != null && expiryDate !== '' && expiryTimestamp(expiryDate) == null) {
      return res.status(400).json({ error: 'Expiry date is invalid' });
    }
    const tags = dietaryTags == null ? null : JSON.stringify(Array.isArray(dietaryTags)
      ? dietaryTags.map(tag => String(tag).trim()).filter(Boolean)
      : String(dietaryTags).split(/[,;]/).map(tag => tag.trim()).filter(Boolean));
    db.prepare(`
      UPDATE food_bank_inventory SET
        quantity_remaining = COALESCE(?, quantity_remaining),
        storage_location   = COALESCE(?, storage_location),
        notes              = COALESCE(?, notes),
        dietary_tags       = COALESCE(?, dietary_tags),
        expiry_date        = COALESCE(?, expiry_date)
      WHERE id = ? AND org_id = ?
    `).run(
      quantityRemaining != null ? Number(quantityRemaining) : null,
      storageLocation ?? null,
      notes ?? null,
      tags,
      expiryDate || null,
      req.params.id, req.user.orgId
    );
    const updated = db.prepare('SELECT expiry_date, quantity_remaining FROM food_bank_inventory WHERE id = ? AND org_id = ?')
      .get(req.params.id, req.user.orgId);
    let matchingTriggered = false;
    if (updated && Number(updated.quantity_remaining) > 0 && expiryTimestamp(updated.expiry_date) > Date.now()) {
      try { await matchOpenDemandsForInventory(); matchingTriggered = true; }
      catch (matchErr) { console.error('[Demand/Inventory update matching]', matchErr); }
    }
    res.json({ success: true, matchingTriggered });
  } catch (err) {
    console.error('[Demand/Inventory PUT]', err);
    res.status(500).json({ error: 'Failed to update inventory item' });
  }
});

// DELETE /api/demand-org/inventory/:id
router.delete('/inventory/:id', authenticate, (req, res) => {
  try {
    const hasMatch = db.prepare('SELECT 1 FROM matches WHERE source_type = ? AND source_inventory_id = ? LIMIT 1')
      .get('food_bank_inventory', req.params.id);
    if (hasMatch) return res.status(409).json({ error: 'Inventory with redistribution history cannot be deleted. Set remaining quantity to 0 instead.' });
    const hasBiogasRoute = db.prepare('SELECT 1 FROM biogas_routes WHERE source_type = ? AND source_inventory_id = ? LIMIT 1')
      .get('food_bank_inventory', req.params.id);
    if (hasBiogasRoute) return res.status(409).json({ error: 'Inventory with biogas routing history cannot be deleted.' });
    db.prepare('DELETE FROM food_bank_inventory WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove inventory item' });
  }
});

// ── Receipt confirmation ───────────────────────────────────────────────────
// POST /api/demand-org/matches/:id/confirm-receipt
router.post('/matches/:id/confirm-receipt', authenticate, async (req, res) => {
  try {
    const match = db.prepare('SELECT * FROM matches WHERE id = ? AND demand_org_id = ?').get(req.params.id, req.user.orgId);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'confirmed') {
      return res.status(409).json({ error: `Receipt can only be confirmed after the match is accepted (current status: ${match.status})` });
    }

    const {
      quantityConfirmed, quantityUnit,
      discrepancyNoted, discrepancyNotes,
      conditionOk, conditionNotes,
      addToInventory, foodName, foodType, expiryDate, storageLocation
    } = req.body;

    const receivedQty = quantityConfirmed != null ? Number(quantityConfirmed) : Number(match.allocated_quantity);
    const receivedUnit = quantityUnit || match.allocated_unit || 'kg';
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      return res.status(400).json({ error: 'Enter a valid received quantity greater than zero' });
    }
    const source = match.source_type === 'food_bank_inventory'
      ? db.prepare('SELECT food_name, food_type, dietary_tags, expiry_date FROM food_bank_inventory WHERE id = ?').get(match.source_inventory_id)
      : db.prepare('SELECT food_name, food_type, dietary_tags, remaining_usable_time FROM surplus_posts WHERE id = ?').get(match.surplus_id);
    if (!source) return res.status(409).json({ error: 'The matched food source is no longer available' });
    const receivedInAllocatedUnit = convertQuantity(receivedQty, receivedUnit, match.allocated_unit || receivedUnit, foodType || source.food_type || '');
    if (!receivedInAllocatedUnit.success) {
      return res.status(400).json({ error: `Received unit cannot be converted to the matched unit: ${receivedInAllocatedUnit.reason}` });
    }
    if (receivedInAllocatedUnit.convertedQty > Number(match.allocated_quantity) + 0.001) {
      return res.status(400).json({ error: 'Received quantity cannot exceed the matched quantity' });
    }

    const sourceExpiry = match.source_type === 'food_bank_inventory'
      ? source?.expiry_date
      : source?.remaining_usable_time;
    const inheritedExpiryDate = expiryValueForInventory(sourceExpiry);
    const inventoryFoodName = req.user.role === 'food_bank' ? (source?.food_name || foodName) : foodName;
    const inventoryFoodType = req.user.role === 'food_bank' ? (source?.food_type || foodType || '') : (foodType || '');
    const inventoryDietaryTags = source?.dietary_tags || '[]';
    const inventoryExpiryDate = req.user.role === 'food_bank'
      ? addFoodBankReceiptAllowance(sourceExpiry || expiryDate)
      : (expiryValueForInventory(expiryDate) || inheritedExpiryDate);
    const shouldAddInventory = req.user.role === 'food_bank' || (addToInventory && foodName);
    if (shouldAddInventory && !inventoryFoodName) {
      return res.status(409).json({ error: 'The matched food details are unavailable, so inventory could not be recorded' });
    }

    const rcId = uuidv4();
    const conditionPassed = !(conditionOk === false || conditionOk === 0);
    const inventoryId = shouldAddInventory ? uuidv4() : null;
    const unreceivedQty = conditionPassed
      ? Math.max(0, Number(match.allocated_quantity) - receivedInAllocatedUnit.convertedQty)
      : Number(match.allocated_quantity);
    const demand = match.demand_id
      ? db.prepare('SELECT quantity_needed, remaining_quantity, quantity_unit, required_by, is_recurring FROM demand_registrations WHERE id = ?').get(match.demand_id)
      : null;
    const demandDeadline = demand?.required_by ? expiryTimestamp(demand.required_by) : null;
    const demandIsExpired = !!(demand && !Number(demand.is_recurring) && demandDeadline != null && demandDeadline <= Date.now());
    db.transaction(() => {
      const freshMatch = db.prepare('SELECT status FROM matches WHERE id = ? AND demand_org_id = ?').get(match.id, req.user.orgId);
      if (!freshMatch || freshMatch.status !== 'confirmed') throw new Error('Receipt has already been recorded or this match has not been accepted');
      db.prepare(`
        INSERT INTO receipt_confirmations
          (id, match_id, org_id, quantity_confirmed, quantity_unit, discrepancy_noted, discrepancy_notes, condition_ok, condition_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rcId, match.id, req.user.orgId, receivedQty, receivedUnit,
        discrepancyNoted ? 1 : 0, discrepancyNotes || '', conditionPassed ? 1 : 0, conditionNotes || ''
      );
      db.prepare("UPDATE matches SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(match.id);

      // The original allocation is reserved before delivery. If less food is
      // confirmed (or the food fails condition checks), reopen only the unmet
      // portion so matching and demand totals reflect what actually arrived.
      if (demand && unreceivedQty > 0.001) {
        const remaining = Math.min(Number(demand.quantity_needed), Number(demand.remaining_quantity || 0) + unreceivedQty);
        const nextStatus = demandIsExpired
          ? 'expired'
          : (remaining <= 0.001 ? 'fulfilled' : (remaining < Number(demand.quantity_needed) ? 'partially_fulfilled' : 'open'));
        db.prepare(`UPDATE demand_registrations
          SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(remaining, nextStatus, match.demand_id);
      }

      // A food bank receipt automatically becomes stock. Condition issues are
      // recorded as a zero-available quarantine entry pending staff review.
      if (shouldAddInventory) {
        const availableQty = conditionPassed ? receivedQty : 0;
        const receiptAllowanceNote = req.user.role === 'food_bank'
          ? `Simulated intake allowance: 3 hours added to source expiry (${inheritedExpiryDate || 'expiry unavailable'}).`
          : '';
        const quarantineNote = conditionPassed ? '' : `QUARANTINED pending review: ${conditionNotes || 'condition issue reported at receipt'}`;
        const inventoryNotes = [receiptAllowanceNote, quarantineNote].filter(Boolean).join(' ');
        db.prepare(`
          INSERT INTO food_bank_inventory
            (id, org_id, match_id, food_name, food_type, dietary_tags, quantity_received, quantity_unit, quantity_remaining, expiry_date, storage_location, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(inventoryId, req.user.orgId, match.id, inventoryFoodName, inventoryFoodType,
          inventoryDietaryTags, receivedQty, receivedUnit, availableQty, inventoryExpiryDate, storageLocation || '', inventoryNotes);
      }
    })();

    const hasUsableNewInventory = shouldAddInventory && conditionPassed && inventoryExpiryDate && expiryTimestamp(inventoryExpiryDate) > Date.now();
    const hasReopenedDemand = demand && !demandIsExpired && unreceivedQty > 0.001;
    if (hasUsableNewInventory || hasReopenedDemand) {
      try { await matchOpenDemandsForInventory(); }
      catch (matchErr) { console.error('[Demand/Receipt inventory matching]', matchErr); }
    }

    res.json({ success: true, confirmationId: rcId, inventoryAdded: !!inventoryId, inventoryQuarantined: !!inventoryId && !conditionPassed });
  } catch (err) {
    console.error('[Demand/ConfirmReceipt]', err);
    if (/already been recorded|has not been accepted/.test(err.message)) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: 'Failed to confirm receipt' });
  }
});

// GET /api/demand-org/inventory-stats — totals for the overview
router.get('/inventory-stats', authenticate, (req, res) => {
  try {
    const orgId = req.user.orgId;
    const availableInventory = db.prepare(`
      SELECT lower(trim(quantity_unit)) AS unit, SUM(quantity_remaining) AS quantity, COUNT(*) AS lots
      FROM food_bank_inventory
      WHERE org_id = ? AND COALESCE(quantity_remaining, 0) > 0
        AND COALESCE(biogas_status, 'available') = 'available'
        AND expiry_date IS NOT NULL
        AND (CASE
          WHEN length(trim(expiry_date)) = 10 THEN julianday(trim(expiry_date) || 'T23:59:59.999+05:30')
          ELSE julianday(expiry_date)
        END) > julianday('now')
      GROUP BY lower(trim(quantity_unit))
      ORDER BY unit
    `).all(orgId);
    const totalItems = availableInventory.reduce((sum, row) => sum + Number(row.lots || 0), 0);
    const totalKg = availableInventory
      .filter(row => ['kg', 'kilogram', 'kilograms', 'kgs'].includes(row.unit))
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const expiringRows = db.prepare(`
      SELECT * FROM food_bank_inventory
      WHERE org_id = ? AND expiry_date IS NOT NULL AND expiry_date <= date('now', '+3 days') AND quantity_remaining > 0
      ORDER BY expiry_date ASC LIMIT 10
    `).all(orgId);
    res.json({ totalItems, totalKgStored: totalKg, availableInventory, expiringSoon: expiringRows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load inventory stats' });
  }
});

module.exports = router;
