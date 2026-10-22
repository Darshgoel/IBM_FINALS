const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { runMatching, generateSurplusPredictions } = require('../services/matching');

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
      UPDATE organizations SET name=?, location_address=?, location_lat=?, location_lng=?,
      operating_hours=?, contact_phone=?, description=? WHERE id=?
    `).run(name, locationAddress, locationLat || 0, locationLng || 0, operatingHours, contactPhone, description, req.user.orgId);

    db.prepare(`
      UPDATE donor_profiles SET food_categories=?, historical_info=?, updated_at=CURRENT_TIMESTAMP WHERE org_id=?
    `).run(JSON.stringify(foodCategories || []), historicalInfo, req.user.orgId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/donor/surplus - Post new surplus
router.post('/surplus', (req, res) => {
  try {
    const {
      foodName, foodType, quantity, quantityUnit, preparationState,
      dietaryTags, availabilityTime, remainingUsableTime, pickupAddress, specialInstructions
    } = req.body;

    if (!foodName || !foodType || !quantity) {
      return res.status(400).json({ error: 'foodName, foodType, and quantity are required' });
    }

    const orgId = req.user.orgId;
    const org = db.prepare('SELECT status FROM organizations WHERE id = ?').get(orgId);
    if (!org || org.status !== 'active') {
      return res.status(403).json({ error: 'Your organization must be verified and active to post surplus' });
    }

    const surplusId = uuidv4();
    db.prepare(`
      INSERT INTO surplus_posts (id, donor_org_id, food_name, food_type, quantity, quantity_unit,
        preparation_state, dietary_tags, availability_time, remaining_usable_time, pickup_address, special_instructions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      surplusId, orgId, foodName, foodType, quantity, quantityUnit || 'kg',
      preparationState || '', JSON.stringify(dietaryTags || []),
      availabilityTime || new Date().toISOString(),
      remainingUsableTime || new Date(Date.now() + 4 * 3600000).toISOString(),
      pickupAddress || '', specialInstructions || ''
    );

    // Trigger automatic matching (async-like, runs synchronously here)
    const matchResult = runMatching(surplusId);

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
      SELECT sp.*, m.status as match_status, m.id as match_id, o.name as matched_org_name
      FROM surplus_posts sp
      LEFT JOIN matches m ON sp.id = m.surplus_id
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
      SELECT sp.*, m.status as match_status, m.id as match_id, m.matched_at,
             o.name as matched_org_name, o.location_address as matched_org_address
      FROM surplus_posts sp
      LEFT JOIN matches m ON sp.id = m.surplus_id
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
router.delete('/surplus/:id', (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM surplus_posts WHERE id = ? AND donor_org_id = ?').get(req.params.id, req.user.orgId);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (['completed', 'in_transit'].includes(post.status)) {
      return res.status(400).json({ error: 'Cannot cancel a post that is in transit or completed' });
    }
    db.prepare("UPDATE surplus_posts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel post' });
  }
});

// GET /api/donor/impact - Get impact statistics
router.get('/impact', (req, res) => {
  try {
    const orgId = req.user.orgId;

    const totalSurplus = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ?').get(orgId);
    
    // Rescued / recovered includes matched, in_transit, and completed donations
    const recovered = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status IN ('matched','in_transit','completed')").get(orgId);
    const completed = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status = 'completed'").get(orgId);
    const matched = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status IN ('matched','in_transit')").get(orgId);
    const available = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status = 'available'").get(orgId);
    const wasted = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(quantity),0) as total FROM surplus_posts WHERE donor_org_id = ? AND status = 'expired'").get(orgId);

    // Build timeline for last 6 calendar months
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
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as posts, SUM(quantity) as quantity
      FROM surplus_posts WHERE donor_org_id = ?
      GROUP BY month
    `).all(orgId);

    dbMonthly.forEach(row => {
      if (monthlyMap[row.month]) {
        monthlyMap[row.month].quantity = Math.round((row.quantity || 0) * 10) / 10;
        monthlyMap[row.month].posts = row.posts;
      }
    });

    const monthlyTrend = months.map(m => monthlyMap[m]);

    const recoveredQty = Math.round((recovered.total || 0) * 10) / 10;
    const mealsEquivalent = Math.round(recoveredQty * 3.5); // ~1 kg ≈ 3.5 meals
    const co2Saved = Math.round(recoveredQty * 2.5 * 10) / 10; // ~2.5 kg CO2e per kg food diverted
    const wasteAvoided = recoveredQty;

    // Category breakdown
    const categoryBreakdown = db.prepare(`
      SELECT food_type, COUNT(*) as count, SUM(quantity) as quantity
      FROM surplus_posts WHERE donor_org_id = ?
      GROUP BY food_type
    `).all(orgId);

    res.json({
      totalPosts: totalSurplus.count || 0,
      totalQuantityPosted: Math.round((totalSurplus.total || 0) * 10) / 10,
      recovered: { count: recovered.count || 0, quantity: recoveredQty },
      completed: { count: completed.count || 0, quantity: Math.round((completed.total || 0) * 10) / 10 },
      matched: matched.count || 0,
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

// PUT /api/donor/alerts/:id/read - Mark alert as read
router.put('/alerts/:id/read', (req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ success: true });
});

module.exports = router;
