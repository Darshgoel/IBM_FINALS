const express = require('express');
const db = require('../database/db');

const router = express.Router();

// Public routes - no auth required for individuals searching for food

// GET /api/recipient/search or /api/recipient/nearby
// Query params: lat, lng, people, urgency, dietary, q
router.get(['/search', '/nearby'], (req, res) => {
  try {
    const { lat, lng, people, urgency, dietary, q } = req.query;

    let querySql = `
      SELECT o.id, o.name, o.type, o.location_address, o.location_lat, o.location_lng,
             o.operating_hours, o.contact_phone, o.description,
             dp.serving_capacity, dp.food_requirements, dp.dietary_restrictions
      FROM organizations o
      JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.status = 'active' AND o.verified = 1
    `;
    const params = [];

    if (q && q.trim()) {
      querySql += ` AND (o.name LIKE ? OR o.location_address LIKE ? OR o.description LIKE ?)`;
      const term = `%${q.trim()}%`;
      params.push(term, term, term);
    }

    querySql += ` ORDER BY o.name`;

    // Find active demand orgs that serve as food access points
    const accessPoints = db.prepare(querySql).all(...params);

    // Enrich each access point with active matches, available food, and distance
    const enriched = accessPoints.map(ap => {
      const activeMatches = db.prepare(`
        SELECT COUNT(*) as count FROM matches m
        WHERE m.demand_org_id = ? AND m.status IN ('pending','confirmed','in_transit','completed')
      `).get(ap.id);

      // Check current surplus or recent food allocations
      const surplusItems = db.prepare(`
        SELECT s.food_name, s.food_type, s.quantity, s.quantity_unit, s.dietary_tags
        FROM matches m
        JOIN surplus_posts s ON m.surplus_id = s.id
        WHERE m.demand_org_id = ? AND m.status IN ('confirmed', 'in_transit', 'completed')
        ORDER BY m.matched_at DESC LIMIT 3
      `).all(ap.id);

      let distance = null;
      if (lat && lng && ap.location_lat && ap.location_lng) {
        const R = 6371;
        const dLat = ((ap.location_lat - parseFloat(lat)) * Math.PI) / 180;
        const dLng = ((ap.location_lng - parseFloat(lng)) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos((parseFloat(lat) * Math.PI) / 180) * Math.cos((ap.location_lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
      }

      // Safe JSON parsing
      let foodReqs = [];
      let dietaryReqs = [];
      try { foodReqs = JSON.parse(ap.food_requirements || '[]'); } catch (e) {}
      try { dietaryReqs = JSON.parse(ap.dietary_restrictions || '[]'); } catch (e) {}

      return {
        ...ap,
        food_requirements: foodReqs,
        dietary_restrictions: dietaryReqs,
        activeIncoming: activeMatches ? activeMatches.count : 0,
        recentSurplus: surplusItems,
        distance
      };
    });

    // Sort: food-available first, then by distance (if available)
    enriched.sort((a, b) => {
      if (a.activeIncoming !== b.activeIncoming) return b.activeIncoming - a.activeIncoming;
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
      return 0;
    });

    res.json({ accessPoints: enriched, count: enriched.length });
  } catch (err) {
    console.error('[Recipient/Search]', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/recipient/access-point/:id
router.get('/access-point/:id', (req, res) => {
  try {
    const org = db.prepare(`
      SELECT o.*, dp.serving_capacity, dp.storage_capacity, dp.food_requirements, dp.dietary_restrictions
      FROM organizations o
      JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.id = ? AND o.status = 'active'
    `).get(req.params.id);

    if (!org) return res.status(404).json({ error: 'Access point not found' });

    let foodReqs = [];
    let dietaryReqs = [];
    try { foodReqs = JSON.parse(org.food_requirements || '[]'); } catch (e) {}
    try { dietaryReqs = JSON.parse(org.dietary_restrictions || '[]'); } catch (e) {}

    // Fetch incoming active food matches
    const activeFood = db.prepare(`
      SELECT s.food_name, s.food_type, s.quantity, s.quantity_unit, s.dietary_tags, m.status, m.matched_at
      FROM matches m
      JOIN surplus_posts s ON m.surplus_id = s.id
      WHERE m.demand_org_id = ? AND m.status IN ('pending', 'confirmed', 'in_transit', 'completed')
      ORDER BY m.matched_at DESC LIMIT 5
    `).all(org.id);

    res.json({
      org: {
        ...org,
        food_requirements: foodReqs,
        dietary_restrictions: dietaryReqs,
        activeFood
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch access point' });
  }
});

module.exports = router;
