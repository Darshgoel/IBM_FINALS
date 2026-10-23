const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { runMatching, runUnifiedMatching, precomputeRoutes, precomputeRoutesToBiogas, generateSurplusPredictions, convertQuantity, matchOpenDemandsForInventory } = require('../services/matching');

const router = express.Router();

// All routes require authentication as donor
router.use(authenticate);
router.use(requireRole('donor'));

// GET /api/donor/profile - Get donor org profile
router.get('/profile', (req, res) => {
  try {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user.orgId);
    const profile = db.prepare('SELECT * FROM donor_profiles WHERE org_id = ?').get(req.user.orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ org, profile });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /api/donor/profile - Update donor org profile
router.put('/profile', (req, res) => {
  try {
    const { name, locationAddress, locationLat, locationLng, operatingHours, contactPhone, description, foodCategories, historicalInfo } = req.body;

    db.prepare(`
      UPDATE organizations SET name=?,
        location_address=?,
        location_lat=COALESCE(?, location_lat),
        location_lng=COALESCE(?, location_lng),
        operating_hours=?, contact_phone=?, description=? WHERE id=?
    `).run(
      name, locationAddress,
      locationLat != null ? locationLat : null,
      locationLng != null ? locationLng : null,
      operatingHours, contactPhone, description, req.user.orgId
    );

    db.prepare(`
      UPDATE donor_profiles SET food_categories=?, historical_info=?, updated_at=CURRENT_TIMESTAMP WHERE org_id=?
    `).run(JSON.stringify(foodCategories || []), historicalInfo, req.user.orgId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/donor/surplus - Post new surplus
router.post('/surplus', async (req, res) => {
  try {
    const {
      foodName, foodType, quantity, quantityUnit, preparationState,
      dietaryTags, availabilityTime, remainingUsableTime, pickupAddress, specialInstructions,
      unsafe
    } = req.body;

    if (!foodName || !foodType || !quantity) {
      return res.status(400).json({ error: 'foodName, foodType, and quantity are required' });
    }

    const orgId = req.user.orgId;
    const org = db.prepare('SELECT status, verified FROM organizations WHERE id = ?').get(orgId);
    if (!org || org.status !== 'active' || !org.verified) {
      return res.status(403).json({ error: 'Your organization must be verified and active to post surplus' });
    }

    const surplusId = uuidv4();
    db.prepare(`
      INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, remaining_quantity, quantity_unit,
        preparation_state, dietary_tags, availability_time, remaining_usable_time, pickup_address, special_instructions, unsafe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      surplusId, orgId, foodName, foodType, quantity, quantity, quantityUnit || 'kg',
      preparationState || '', JSON.stringify(dietaryTags || []),
      availabilityTime || new Date().toISOString(),
      remainingUsableTime || new Date(Date.now() + 4 * 3600000).toISOString(),
      pickupAddress || '', specialInstructions || '',
      unsafe ? 1 : 0
    );

    // Pre-compute routes to all candidate demand orgs AND biogas facilities before the sync tx
    const donorOrg = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
    const candidateOrgs = db.prepare(`
      SELECT DISTINCT o.id, o.location_lat, o.location_lng
      FROM organizations o
      WHERE o.status = 'active' AND o.verified = 1 AND (
        EXISTS (
          SELECT 1 FROM demand_registrations d
          WHERE d.demand_org_id = o.id
            AND d.status IN ('open', 'partially_fulfilled')
            AND COALESCE(d.remaining_quantity, d.quantity_needed) > 0
        )
        OR (o.type LIKE '%food_bank%' AND EXISTS (
          SELECT 1 FROM demand_org_profiles dp WHERE dp.org_id = o.id
        ))
      )
    `).all();
    const [routeResults, biogasRouteResults] = await Promise.all([
      precomputeRoutes(donorOrg, candidateOrgs),
      precomputeRoutesToBiogas(donorOrg)
    ]);

    // Trigger automatic matching using unified matcher
    const matchResult = runUnifiedMatching({ surplusId, routeResults, biogasRouteResults });

    res.status(201).json({
      success: true,
      surplusId,
      message: 'Surplus posted. Matching in progress.',
      matchResult
    });
  } catch (err) {
    console.error('[Donor/Surplus]', err);
    res.status(500).json({ error: 'Failed to post surplus' });
  }
});

// GET /api/donor/surplus - Get all surplus posts for this donor
router.get('/surplus', (req, res) => {
  try {
    const posts = db.prepare(`
      SELECT sp.*, m.status as match_status, m.id as match_id, m.match_score,
             m.allocated_quantity, m.allocated_unit, m.explanation as match_explanation,
             m.notes as match_notes, m.route_distance_km, m.route_duration_minutes, m.route_provider,
             o.name as matched_org_name
      FROM surplus_posts sp
      LEFT JOIN matches m ON sp.id = m.surplus_id AND m.status != 'cancelled' AND m.status != 'declined'
      LEFT JOIN organizations o ON m.demand_org_id = o.id
      WHERE sp.donor_org_id = ?
      ORDER BY sp.created_at DESC
    `).all(req.user.orgId);

    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch surplus posts' });
  }
});

// GET /api/donor/surplus/:id - Get specific surplus post
router.get('/surplus/:id', (req, res) => {
  try {
    const post = db.prepare(`
      SELECT sp.*, m.status as match_status, m.id as match_id, m.matched_at, m.match_score,
             m.allocated_quantity, m.allocated_unit, m.explanation as match_explanation,
             o.name as matched_org_name, o.location_address as matched_org_address
      FROM surplus_posts sp
      LEFT JOIN matches m ON sp.id = m.surplus_id AND m.status != 'cancelled' AND m.status != 'declined'
      LEFT JOIN organizations o ON m.demand_org_id = o.id
      WHERE sp.id = ? AND sp.donor_org_id = ?
    `).get(req.params.id, req.user.orgId);

    if (!post) return res.status(404).json({ error: 'Surplus post not found' });
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// DELETE /api/donor/surplus/:id - Cancel surplus post
router.delete('/surplus/:id', async (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM surplus_posts WHERE id = ? AND donor_org_id = ?').get(req.params.id, req.user.orgId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.status === 'completed') {
      return res.status(400).json({ error: 'Cannot cancel a completed post' });
    }
    const committedMatch = db.prepare(`
      SELECT 1 FROM matches WHERE surplus_id = ? AND status IN ('confirmed', 'completed', 'matched') LIMIT 1
    `).get(req.params.id);
    if (committedMatch) {
      return res.status(409).json({ error: 'This surplus has an accepted or completed handover and can no longer be cancelled here.' });
    }

    const releasedMatchCount = db.transaction(() => {
      // Find pending matches and release reserved demand quantities
      const pendingMatches = db.prepare("SELECT * FROM matches WHERE surplus_id = ? AND status = 'pending'").all(req.params.id);
      const surplus = db.prepare('SELECT * FROM surplus_posts WHERE id = ?').get(req.params.id);
      for (const m of pendingMatches) {
        db.prepare("UPDATE matches SET status = 'cancelled', notes = 'Surplus was cancelled by donor', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
        const alloc = m.allocated_quantity || 0;
        if (m.demand_id && alloc > 0) {
          // allocated_quantity is in the demand's unit; restore demand balance directly.
          db.prepare(`
            UPDATE demand_registrations
            SET remaining_quantity = MIN(quantity_needed, remaining_quantity + ?),
                status = CASE WHEN remaining_quantity + ? >= quantity_needed THEN 'open' ELSE 'partially_fulfilled' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(alloc, alloc, m.demand_id);
        }
        // Note: surplus is being cancelled entirely so there is no need to restore
        // its remaining_quantity; the status update below closes the record.
      }
      db.prepare("UPDATE surplus_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
      return pendingMatches.length;
    })();

    if (releasedMatchCount > 0) {
      try { await matchOpenDemandsForInventory(); }
      catch (matchErr) { console.error('[Donor/Cancel rematching]', matchErr); }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel post' });
  }
});

// GET /api/donor/impact - Get impact statistics
router.get('/impact', (req, res) => {
  try {
    const orgId = req.user.orgId;

    // totalSurplus: post counts and originally posted quantities (what was offered)
    const totalSurplus = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ?').get(orgId);
    const available = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(remaining_quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status = 'available'").get(orgId);
    const wasted = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status = 'expired'").get(orgId);

    // Recovered / completed quantities are derived from match allocations, not surplus post totals,
    // because a single post may be split across multiple partial allocations.
    const recoveredMatches = db.prepare(`
      SELECT COUNT(DISTINCT sp.id) as count,
             COALESCE(SUM(m.allocated_quantity), 0) as total,
             m.allocated_unit as unit
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      WHERE sp.donor_org_id = ? AND m.status = 'completed'
        AND m.notes != 'fallback_food_bank'
      GROUP BY m.allocated_unit
    `).all(orgId);

    const completedMatches = db.prepare(`
      SELECT COALESCE(SUM(m.allocated_quantity), 0) as total, m.allocated_unit as unit
      FROM matches m
      JOIN surplus_posts sp ON m.surplus_id = sp.id
      WHERE sp.donor_org_id = ? AND m.status = 'completed'
      GROUP BY m.allocated_unit
    `).all(orgId);
    const matchedListings = db.prepare(`
      SELECT COUNT(DISTINCT sp.id) as count
      FROM surplus_posts sp
      JOIN matches m ON sp.id = m.surplus_id
      WHERE sp.donor_org_id = ? AND m.status IN ('pending','confirmed','matched','completed')
    `).get(orgId);

    // Aggregate totals (convert to kg-equivalent for CO₂/meal calculations)
    // Conversion factors: 1 serving ≈ 0.4 kg, 1 liter ≈ 1 kg
    function toKgEquivalent(qty, unit) {
      const u = (unit || 'kg').toLowerCase();
      if (u === 'servings' || u === 'serving' || u === 'portions' || u === 'portion') return qty * 0.4;
      if (u === 'liters' || u === 'liter' || u === 'litres' || u === 'litre') return qty;
      if (u === 'g' || u === 'gram' || u === 'grams') return qty / 1000;
      return qty; // kg
    }

    const recoveredKg = recoveredMatches.reduce((s, r) => s + toKgEquivalent(r.total, r.unit), 0);
    const completedKg = completedMatches.reduce((s, r) => s + toKgEquivalent(r.total, r.unit), 0);

    const recoveredQty = Math.round(recoveredKg * 10) / 10;
    const mealsEquivalent = Math.round(recoveredKg * 3.5); // ~1 kg ≈ 3.5 meals
    const co2Saved = Math.round(recoveredKg * 2.5 * 10) / 10; // ~2.5 kg CO₂e per kg food diverted
    const wasteAvoided = recoveredQty;

    // Build timeline for last 6 calendar months using allocated match quantities
    const monthlyMap = {};
    const months = [];
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
      monthlyMap[mStr] = { month: label, key: mStr, quantity: 0, posts: 0 };
      months.push(mStr);
    }

    const dbMonthly = db.prepare(`
      SELECT strftime('%Y-%m', sp.created_at) as month, COUNT(DISTINCT sp.id) as posts,
             SUM(m.allocated_quantity) as quantity, m.allocated_unit as unit
      FROM surplus_posts sp
      JOIN matches m ON sp.id = m.surplus_id
      WHERE sp.donor_org_id = ? AND m.status = 'completed'
      GROUP BY month, m.allocated_unit
    `).all(orgId);

    dbMonthly.forEach(row => {
      if (monthlyMap[row.month]) {
        monthlyMap[row.month].quantity = Math.round(
          ((monthlyMap[row.month].quantity || 0) + toKgEquivalent(row.quantity || 0, row.unit)) * 10
        ) / 10;
        monthlyMap[row.month].posts = row.posts;
      }
    });

    const monthlyTrend = months.map(m => monthlyMap[m]);

    // Category breakdown using allocated quantities from matches
    const categoryBreakdown = db.prepare(`
      SELECT sp.food_type, COUNT(DISTINCT sp.id) as count,
             SUM(m.allocated_quantity) as quantity, m.allocated_unit as unit
      FROM surplus_posts sp
      JOIN matches m ON sp.id = m.surplus_id
      WHERE sp.donor_org_id = ? AND m.status = 'completed'
      GROUP BY sp.food_type, m.allocated_unit
    `).all(orgId);

    res.json({
      totalPosts: totalSurplus.count || 0,
      totalQuantityPosted: Math.round((totalSurplus.total || 0) * 10) / 10,
      recovered: { count: recoveredMatches.reduce((s, r) => s + r.count, 0), quantity: recoveredQty },
      completed: { count: completedMatches.length, quantity: Math.round(completedKg * 10) / 10 },
      matched: matchedListings.count || 0,
      available: available.count || 0,
      wasted: { count: wasted.count || 0, quantity: Math.round((wasted.total || 0) * 10) / 10 },
      mealsEquivalent,
      co2Saved,
      wasteAvoided,
      monthlyTrend,
      categoryBreakdown
    });
  } catch (err) {
    console.error('Impact route error:', err);
    res.status(500).json({ error: 'Failed to fetch impact data' });
  }
});

// GET /api/donor/predictions - Get surplus predictions
router.get('/predictions', (req, res) => {
  try {
    const rawPrediction = generateSurplusPredictions(req.user.orgId);
    const prediction = rawPrediction ? {
      expectedQty: rawPrediction.predictedQuantity,
      predictedQuantity: rawPrediction.predictedQuantity,
      foodType: rawPrediction.predictedFoodType,
      predictedFoodType: rawPrediction.predictedFoodType,
      confidence: rawPrediction.confidence
    } : null;

    // Also get recent patterns
    const patterns = db.prepare(`
      SELECT food_type, COUNT(*) as frequency, AVG(quantity) as avg_qty,
             strftime('%H', availability_time) as typical_hour
      FROM surplus_posts WHERE donor_org_id = ?
      GROUP BY food_type ORDER BY frequency DESC LIMIT 5
    `).all(req.user.orgId);

    // High-risk days (days with most surplus historically)
    const riskDays = db.prepare(`
      SELECT strftime('%w', created_at) as day_of_week, COUNT(*) as count
      FROM surplus_posts WHERE donor_org_id = ?
      GROUP BY day_of_week ORDER BY count DESC
    `).all(req.user.orgId);

    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const riskDayLabels = riskDays.map(d => ({ day: dayNames[d.day_of_week], count: d.count }));

    res.json({ prediction, patterns, riskDays: riskDayLabels });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch predictions' });
  }
});

// GET /api/donor/alerts - Get unread alerts
router.get('/alerts', (req, res) => {
  try {
    const alerts = db.prepare(`
      SELECT * FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(req.user.orgId);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// PUT /api/donor/alerts/read-all - Mark all alerts read for this org (must be before /:id route)
router.put('/alerts/read-all', (req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE org_id = ?').run(req.user.orgId);
  res.json({ success: true });
});

// PUT /api/donor/alerts/:id/read - Mark single alert as read
router.put('/alerts/:id/read', (req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ success: true });
});

module.exports = router;
