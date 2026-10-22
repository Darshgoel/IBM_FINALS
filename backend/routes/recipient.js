const express = require('express');
const db = require('../database/db');

const router = express.Router();

// Public routes - no auth required for individuals searching for food

// GET /api/recipient/search?lat=&lng=&people=&urgency=
router.get('/search', (req, res) => {
  try {
    const { lat, lng, people, urgency } = req.query;

    // Find active demand orgs that serve as food access points
    const accessPoints = db.prepare(`
      SELECT o.id, o.name, o.type, o.location_address, o.location_lat, o.location_lng,
             o.operating_hours, o.contact_phone, dp.serving_capacity, dp.food_requirements
      FROM organizations o
      JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.status = 'active' AND o.verified = 1
      ORDER BY o.name
    `).all();

    // Check which of these have active matches (food available)
    const enriched = accessPoints.map(ap => {
      const activeMatches = db.prepare(`
        SELECT COUNT(*) as count FROM matches m
        WHERE m.demand_org_id = ? AND m.status IN ('pending','confirmed','in_transit')
      `).get(ap.id);

      let distance = null;
      if (lat && lng && ap.location_lat && ap.location_lng) {
        const R = 6371;
        const dLat = ((ap.location_lat - parseFloat(lat)) * Math.PI) / 180;
        const dLng = ((ap.location_lng - parseFloat(lng)) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos((parseFloat(lat) * Math.PI) / 180) * Math.cos((ap.location_lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
      }

      return { ...ap, activeIncoming: activeMatches.count, distance };
    });

    // Sort: food-available first, then by distance
    enriched.sort((a, b) => {
      if (a.activeIncoming !== b.activeIncoming) return b.activeIncoming - a.activeIncoming;
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
      return 0;
    });

    res.json({ accessPoints: enriched });
  } catch (err) {
    console.error('[Recipient/Search]', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/recipient/access-point/:id
router.get('/access-point/:id', (req, res) => {
  try {
    const org = db.prepare('SELECT o.*, dp.serving_capacity, dp.food_requirements, dp.dietary_restrictions FROM organizations o JOIN demand_org_profiles dp ON o.id = dp.org_id WHERE o.id = ? AND o.status = ?').get(req.params.id, 'active');
    if (!org) return res.status(404).json({ error: 'Access point not found' });
    res.json({ org });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch access point' });
  }
});

module.exports = router;
