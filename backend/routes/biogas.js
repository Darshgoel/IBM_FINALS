/**
 * Biogas Operator routes
 * All routes require authentication and the biogas_operator role.
 *
 * GET  /api/biogas/facility          — own facility profile
 * PUT  /api/biogas/facility          — update profile (waste types, hours, contact, location)
 * PUT  /api/biogas/capacity          — update daily capacity & current intake
 * PUT  /api/biogas/availability      — toggle is_available flag
 * GET  /api/biogas/routes            — incoming biogas routes assigned to this facility
 * PUT  /api/biogas/routes/:id/status — accept / reject / complete a biogas route
 * GET  /api/biogas/unowned           — list facilities without an operator (claim flow)
 * POST /api/biogas/claim/:id         — claim an existing facility record
 * GET  /api/biogas/alerts            — alerts for the operator
 * PUT  /api/biogas/alerts/:id/read   — mark alert read
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');

const router = express.Router();

// ── Helper: resolve the caller's facility ─────────────────────────────────────
function getOperatorFacility(userId) {
  return db.prepare('SELECT * FROM biogas_facilities WHERE operator_user_id = ? LIMIT 1').get(userId);
}

function requireFacilityNotRejected(req, res, next) {
  const facility = getOperatorFacility(req.user.id);
  if (facility?.status === 'rejected') {
    return res.status(403).json({ error: 'This facility registration was rejected. Contact FoodBridge support for next steps.' });
  }
  next();
}

function requireActiveFacility(req, res, next) {
  const facility = getOperatorFacility(req.user.id);
  if (!facility) return res.status(403).json({ error: 'No facility is linked to this operator account.' });
  if (facility.status !== 'active') {
    return res.status(403).json({ error: 'This facility is awaiting admin approval and cannot use operational features yet.' });
  }
  next();
}

// ── GET /api/biogas/facility ─────────────────────────────────────────────────
router.get('/facility', authenticate, requireRole('biogas_operator'), requireFacilityNotRejected, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });

    const parsed = { ...facility };
    try { parsed.accepted_waste_types = JSON.parse(facility.accepted_waste_types || '[]'); } catch { parsed.accepted_waste_types = []; }
    res.json(parsed);
  } catch (err) {
    console.error('[Biogas/Facility GET]', err);
    res.status(500).json({ error: 'Failed to load facility' });
  }
});

// ── PUT /api/biogas/facility ─────────────────────────────────────────────────
router.put('/facility', authenticate, requireRole('biogas_operator'), requireFacilityNotRejected, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });

    const {
      name, locationAddress, locationLat, locationLng,
      contactPhone, contactEmail, operatingHours,
      acceptedWasteTypes, notes
    } = req.body;

    db.prepare(`
      UPDATE biogas_facilities SET
        name              = COALESCE(?, name),
        location_address  = COALESCE(?, location_address),
        location_lat      = COALESCE(?, location_lat),
        location_lng      = COALESCE(?, location_lng),
        contact_phone     = COALESCE(?, contact_phone),
        contact_email     = COALESCE(?, contact_email),
        operating_hours   = COALESCE(?, operating_hours),
        accepted_waste_types = COALESCE(?, accepted_waste_types),
        notes             = COALESCE(?, notes),
        updated_at        = datetime('now')
      WHERE id = ?
    `).run(
      name || null,
      locationAddress || null,
      locationLat != null ? Number(locationLat) : null,
      locationLng != null ? Number(locationLng) : null,
      contactPhone || null,
      contactEmail || null,
      operatingHours || null,
      acceptedWasteTypes != null ? JSON.stringify(Array.isArray(acceptedWasteTypes) ? acceptedWasteTypes : [acceptedWasteTypes]) : null,
      notes || null,
      facility.id
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Biogas/Facility PUT]', err);
    res.status(500).json({ error: 'Failed to update facility' });
  }
});

// ── PUT /api/biogas/capacity ─────────────────────────────────────────────────
router.put('/capacity', authenticate, requireRole('biogas_operator'), requireActiveFacility, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });

    const { maxDailyIntakeKg, currentIntakeKg, capacityUnit } = req.body;
    if (maxDailyIntakeKg != null && Number(maxDailyIntakeKg) < 0) {
      return res.status(400).json({ error: 'maxDailyIntakeKg must be >= 0' });
    }
    if (currentIntakeKg != null && Number(currentIntakeKg) < 0) {
      return res.status(400).json({ error: 'currentIntakeKg must be >= 0' });
    }

    db.prepare(`
      UPDATE biogas_facilities SET
        max_daily_intake_kg = COALESCE(?, max_daily_intake_kg),
        current_intake_kg   = COALESCE(?, current_intake_kg),
        capacity_unit       = COALESCE(?, capacity_unit),
        updated_at          = datetime('now')
      WHERE id = ?
    `).run(
      maxDailyIntakeKg != null ? Number(maxDailyIntakeKg) : null,
      currentIntakeKg != null ? Number(currentIntakeKg) : null,
      capacityUnit || null,
      facility.id
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Biogas/Capacity PUT]', err);
    res.status(500).json({ error: 'Failed to update capacity' });
  }
});

// ── PUT /api/biogas/availability ─────────────────────────────────────────────
router.put('/availability', authenticate, requireRole('biogas_operator'), requireActiveFacility, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });

    const available = req.body.available;
    if (available == null) return res.status(400).json({ error: '"available" boolean is required' });

    db.prepare('UPDATE biogas_facilities SET is_available = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(available ? 1 : 0, facility.id);

    res.json({ success: true, isAvailable: !!available });
  } catch (err) {
    console.error('[Biogas/Availability PUT]', err);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// ── GET /api/biogas/routes ───────────────────────────────────────────────────
router.get('/routes', authenticate, requireRole('biogas_operator'), requireActiveFacility, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });

    const routes = db.prepare(`
      SELECT br.*,
             o.name AS donor_name,
             o.location_address AS donor_address,
             o.contact_phone AS donor_phone
      FROM biogas_routes br
      LEFT JOIN organizations o ON o.id = br.donor_org_id
      WHERE br.biogas_facility_id = ?
      ORDER BY br.created_at DESC
      LIMIT 200
    `).all(facility.id);

    // Compute today's intake from received_at timestamp — single source of truth
    const today = new Date().toISOString().slice(0, 10);
    const todayIntakeKg = routes
      .filter(r => r.status === 'received' && r.received_at && r.received_at.slice(0, 10) === today)
      .reduce((s, r) => s + (Number(r.weigh_in_kg || r.quantity) || 0), 0);

    res.json({ routes, todayIntakeKg });
  } catch (err) {
    console.error('[Biogas/Routes GET]', err);
    res.status(500).json({ error: 'Failed to load routes' });
  }
});

// ── POST /api/biogas/capacity/reset — reset daily intake counter ─────────────
router.post('/capacity/reset', authenticate, requireRole('biogas_operator'), requireActiveFacility, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });
    db.prepare("UPDATE biogas_facilities SET current_intake_kg = 0, intake_date = date('now'), updated_at = datetime('now') WHERE id = ?").run(facility.id);
    res.json({ success: true, currentIntakeKg: 0 });
  } catch (err) {
    console.error('[Biogas/Capacity Reset]', err);
    res.status(500).json({ error: 'Failed to reset intake' });
  }
});

// ── PUT /api/biogas/routes/:id/status ────────────────────────────────────────
router.put('/routes/:id/status', authenticate, requireRole('biogas_operator'), requireActiveFacility, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    if (!facility) return res.status(404).json({ error: 'No facility linked to your account' });

    const route = db.prepare('SELECT * FROM biogas_routes WHERE id = ?').get(req.params.id);
    if (!route) return res.status(404).json({ error: 'Route not found' });
    if (route.biogas_facility_id !== facility.id) return res.status(403).json({ error: 'Route does not belong to your facility' });

    const { status, weighInKg, processingNotes } = req.body;
    const VALID = ['accepted', 'received', 'rejected'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    }
    if (['accepted', 'rejected'].includes(status) && route.status !== 'pending') {
      return res.status(409).json({ error: `Route cannot be ${status} from its current status (${route.status})` });
    }
    if (status === 'received' && route.status !== 'accepted') {
      return res.status(409).json({ error: `Route can only be marked received after acceptance (current status: ${route.status})` });
    }

    const updateFields = ['status = ?'];
    const updateValues = [status];

    if (status === 'received') {
      updateFields.push("received_at = datetime('now')");
      // Use weigh-in quantity if provided, otherwise fall back to route quantity
      const actualKg = weighInKg != null ? Number(weighInKg) : (Number(route.quantity) || 0);
      if (weighInKg != null) updateFields.push('weigh_in_kg = ?'), updateValues.push(actualKg);

      // Reset daily intake counter if the date has changed
      const today = new Date().toISOString().slice(0, 10);
      const intakeDate = facility.intake_date ? facility.intake_date.slice(0, 10) : null;
      const currentIntake = intakeDate === today ? (facility.current_intake_kg || 0) : 0;

      db.prepare(`UPDATE biogas_facilities SET
        current_intake_kg = ?, intake_date = date('now'), updated_at = datetime('now')
        WHERE id = ?`).run(currentIntake + actualKg, facility.id);
    }

    if (processingNotes) {
      updateFields.push('processing_notes = ?');
      updateValues.push(processingNotes);
    }

    updateValues.push(route.id);
    db.transaction(() => {
      db.prepare(`UPDATE biogas_routes SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);
      if (status === 'accepted') {
        if (route.source_type === 'food_bank_inventory') {
          db.prepare(`UPDATE food_bank_inventory SET biogas_status = 'accepted' WHERE id = ? AND biogas_status = 'pending'`)
            .run(route.source_inventory_id);
        } else {
          db.prepare(`
            UPDATE surplus_posts SET status = 'biogas_routed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'biogas_pending'
          `).run(route.surplus_id);
        }
      } else if (status === 'received' && route.source_type === 'food_bank_inventory') {
        db.prepare(`UPDATE food_bank_inventory SET biogas_status = 'received', biogas_reason = '' WHERE id = ?`)
          .run(route.source_inventory_id);
      } else if (status === 'rejected') {
        const reason = `Biogas centre "${facility.name}" declined the route; coordinator review is required.`;
        if (route.source_type === 'food_bank_inventory') {
          db.prepare(`
            UPDATE food_bank_inventory
            SET quantity_remaining = MIN(quantity_received, COALESCE(quantity_remaining, 0) + ?),
                biogas_status = 'review_required', biogas_reason = ?
            WHERE id = ? AND biogas_status IN ('pending', 'accepted')
          `).run(route.quantity || 0, reason, route.source_inventory_id);
        } else {
          db.prepare(`
            UPDATE surplus_posts
            SET remaining_quantity = MIN(quantity, COALESCE(remaining_quantity, 0) + ?),
                status = 'review_required',
                review_reason = ?, biogas_reason = '', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'biogas_pending'
          `).run(route.quantity || 0, reason, route.surplus_id);
        }
      }
    })();

    if (status === 'accepted' || status === 'rejected') {
      dispatchNotification({
        orgId: route.donor_org_id,
        type: status === 'accepted' ? 'success' : 'alert',
        title: status === 'accepted' ? 'Biogas route accepted' : 'Biogas route declined',
        message: status === 'accepted'
          ? `${facility.name} accepted the biogas delivery request for ${route.food_name}.`
          : `${facility.name} declined the biogas delivery request for ${route.food_name}. The surplus needs coordinator review.`
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    console.error('[Biogas/Routes Status PUT]', err);
    res.status(500).json({ error: 'Failed to update route status' });
  }
});

// ── GET /api/biogas/unowned — facilities without an operator (for claim UI) ──
router.get('/unowned', authenticate, requireRole('biogas_operator'), (req, res) => {
  try {
    const facilities = db.prepare(`
      SELECT id, name, location_address, location_lat, location_lng, status, verified,
             accepted_waste_types, max_daily_intake_kg
      FROM biogas_facilities
      WHERE operator_user_id IS NULL
      ORDER BY name
    `).all();
    res.json(facilities.map(f => ({
      ...f,
      accepted_waste_types: (() => { try { return JSON.parse(f.accepted_waste_types || '[]'); } catch { return []; } })()
    })));
  } catch (err) {
    console.error('[Biogas/Unowned GET]', err);
    res.status(500).json({ error: 'Failed to fetch unowned facilities' });
  }
});

// ── POST /api/biogas/claim/:id — claim an existing unowned facility ───────────
router.post('/claim/:id', authenticate, requireRole('biogas_operator'), (req, res) => {
  try {
    const alreadyOwns = getOperatorFacility(req.user.id);
    if (alreadyOwns) return res.status(409).json({ error: 'Your account is already linked to a facility' });

    const facility = db.prepare('SELECT id, operator_user_id FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });
    if (facility.operator_user_id) return res.status(409).json({ error: 'This facility already has an operator' });

    db.prepare('UPDATE biogas_facilities SET operator_user_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(req.user.id, facility.id);

    res.json({ success: true, facilityId: facility.id });
  } catch (err) {
    console.error('[Biogas/Claim POST]', err);
    res.status(500).json({ error: 'Failed to claim facility' });
  }
});

// ── GET /api/biogas/alerts ────────────────────────────────────────────────────
router.get('/alerts', authenticate, requireRole('biogas_operator'), requireFacilityNotRejected, (req, res) => {
  try {
    const facility = getOperatorFacility(req.user.id);
    // Alerts may be targeted at the user or org; for biogas we match user_id
    const alerts = db.prepare(`
      SELECT * FROM alerts
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(req.user.id);
    res.json(alerts);
  } catch (err) {
    console.error('[Biogas/Alerts GET]', err);
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

// ── PUT /api/biogas/alerts/:id/read ──────────────────────────────────────────
router.put('/alerts/:id/read', authenticate, requireRole('biogas_operator'), requireFacilityNotRejected, (req, res) => {
  try {
    db.prepare("UPDATE alerts SET is_read = 1 WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Biogas/Alerts Read PUT]', err);
    res.status(500).json({ error: 'Failed to mark alert read' });
  }
});

module.exports = router;
