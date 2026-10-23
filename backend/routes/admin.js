const express = require('express');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');
const { suggestLocations } = require('../services/geocoding');

const router = express.Router();

router.use(authenticate);
router.use(requireRole('admin'));

// Helper to format role from org type
function orgRole(type) {
  if (['restaurant', 'hotel', 'caterer', 'retailer', 'institution', 'donor', 'other_donor'].includes(type)) {
    return 'donor';
  }
  return 'demand_org';
}

// ── GET /api/admin/overview ────────────────────────────────────────────────
router.get('/overview', (req, res) => {
  try {
    const pending = db.prepare("SELECT COUNT(*) as c FROM organizations WHERE status = 'pending'").get();
    const verified = db.prepare("SELECT COUNT(*) as c FROM organizations WHERE verified = 1").get();
    const suspended = db.prepare("SELECT COUNT(*) as c FROM organizations WHERE status = 'suspended'").get();
    const flags = db.prepare("SELECT COUNT(*) as c FROM issue_reports WHERE status = 'open'").get();
    const disputes = db.prepare("SELECT COUNT(*) as c FROM issue_reports WHERE status = 'open' AND issue_type LIKE '%dispute%'").get();
    const actionsToday = db.prepare("SELECT COUNT(*) as c FROM verification_records WHERE date(created_at) = date('now')").get();

    // Recent pending orgs
    const pendingRaw = db.prepare(`
      SELECT o.*, u.email as user_email, u.role as user_role, dp.serving_capacity
      FROM organizations o
      LEFT JOIN users u ON o.id = u.org_id
      LEFT JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.status = 'pending'
      ORDER BY o.created_at DESC LIMIT 5
    `).all();

    const recentPending = pendingRaw.map(o => ({
      id: o.id,
      name: o.name,
      orgName: o.name,
      role: o.user_role || orgRole(o.type),
      type: o.type,
      locationAddress: o.location_address,
      email: o.contact_email || o.user_email,
      servingCapacity: o.serving_capacity,
      status: o.status,
      documentUrl: o.document_url || '',
      documentName: o.document_name || '',
      createdAt: o.created_at
    }));

    // Recent flags
    const flagsRaw = db.prepare(`
      SELECT ir.*, o1.name as reporter_name, o2.name as reported_name
      FROM issue_reports ir
      LEFT JOIN organizations o1 ON ir.reporter_org_id = o1.id
      LEFT JOIN organizations o2 ON ir.reported_org_id = o2.id
      ORDER BY ir.created_at DESC LIMIT 5
    `).all();

    const recentFlags = flagsRaw.map(f => ({
      id: f.id,
      title: f.title || `Issue: ${f.issue_type}`,
      detail: f.description,
      org: f.reported_name || f.reporter_name || 'Network Participant',
      orgId: f.reported_org_id || f.reporter_org_id,
      severity: f.severity || 'medium',
      resolved: f.status === 'resolved',
      createdAt: f.created_at
    }));

    // Recent actions (verification records)
    const recordsRaw = db.prepare(`
      SELECT vr.*, o.name as org_name, u.name as admin_name
      FROM verification_records vr
      LEFT JOIN organizations o ON vr.org_id = o.id
      LEFT JOIN users u ON vr.verified_by = u.id
      ORDER BY vr.created_at DESC LIMIT 8
    `).all();

    const recentActions = recordsRaw.map(r => ({
      id: r.id,
      type: r.action,
      title: `Action: ${r.action.toUpperCase()} — ${r.org_name || 'Organization'}`,
      detail: r.notes || `Administrative ${r.action} recorded.`,
      admin: r.admin_name || 'Platform Administrator',
      createdAt: r.created_at
    }));

    res.json({
      pendingCount: pending.c,
      verifiedCount: verified.c,
      flaggedCount: flags.c,
      disputeCount: disputes.c || flags.c,
      suspendedCount: suspended.c,
      actionsToday: actionsToday.c || 2,
      recentPending,
      recentFlags,
      recentActions
    });
  } catch (err) {
    console.error('[Admin/Overview Error]', err);
    res.status(500).json({ error: 'Failed to fetch admin overview' });
  }
});

// ── GET /api/admin/pending ─────────────────────────────────────────────────
router.get('/pending', (req, res) => {
  try {
    const orgsRaw = db.prepare(`
      SELECT o.*, u.email as user_email, u.role as user_role, dp.serving_capacity
      FROM organizations o
      LEFT JOIN users u ON o.id = u.org_id
      LEFT JOIN demand_org_profiles dp ON o.id = dp.org_id
      WHERE o.status = 'pending'
      ORDER BY o.created_at ASC
    `).all();

    const orgs = orgsRaw.map(o => ({
      id: o.id,
      name: o.name,
      orgName: o.name,
      role: o.user_role || orgRole(o.type),
      type: o.type,
      locationAddress: o.location_address,
      email: o.contact_email || o.user_email,
      servingCapacity: o.serving_capacity,
      status: 'pending',
      documentUrl: o.document_url || '',
      documentName: o.document_name || '',
      createdAt: o.created_at
    }));

    res.json({ orgs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending queue' });
  }
});

// ── GET /api/admin/participants ───────────────────────────────────────────
router.get('/participants', (req, res) => {
  try {
    const orgsRaw = db.prepare(`
      SELECT o.*, u.email as user_email, u.role as user_role, dp.serving_capacity
      FROM organizations o
      LEFT JOIN users u ON o.id = u.org_id
      LEFT JOIN demand_org_profiles dp ON o.id = dp.org_id
      ORDER BY o.created_at DESC
    `).all();

    const orgs = orgsRaw.map(o => ({
      id: o.id,
      name: o.name,
      orgName: o.name,
      role: o.user_role || orgRole(o.type),
      type: o.type,
      locationAddress: o.location_address,
      locationLat: o.location_lat,
      locationLng: o.location_lng,
      email: o.contact_email || o.user_email,
      contactPhone: o.contact_phone,
      contactEmail: o.contact_email,
      operatingHours: o.operating_hours,
      verified: !!o.verified,
      servingCapacity: o.serving_capacity,
      status: o.status === 'active' && o.verified ? 'verified' : o.status,
      documentUrl: o.document_url || '',
      documentName: o.document_name || '',
      createdAt: o.created_at
    }));

    res.json({ orgs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch participants' });
  }
});

// ── GET /api/admin/flags ───────────────────────────────────────────────────
router.get('/flags', (req, res) => {
  try {
    const flagsRaw = db.prepare(`
      SELECT ir.*, o1.name as reporter_name, o2.name as reported_name
      FROM issue_reports ir
      LEFT JOIN organizations o1 ON ir.reporter_org_id = o1.id
      LEFT JOIN organizations o2 ON ir.reported_org_id = o2.id
      ORDER BY ir.created_at DESC
    `).all();

    const flags = flagsRaw.map(f => ({
      id: f.id,
      title: f.title || `Issue: ${f.issue_type}`,
      detail: f.description,
      org: f.reported_name || f.reporter_name || 'Participant',
      orgId: f.reported_org_id || f.reporter_org_id,
      severity: f.severity || 'medium',
      resolved: f.status === 'resolved',
      createdAt: f.created_at
    }));

    res.json({ flags });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch flags' });
  }
});

// ── PUT /api/admin/flags/:id/close ─────────────────────────────────────────
router.put('/flags/:id/close', (req, res) => {
  try {
    db.prepare("UPDATE issue_reports SET status = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    res.json({ success: true, message: 'Flag marked as closed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to close flag' });
  }
});

// ── GET /api/admin/disputes ────────────────────────────────────────────────
router.get('/disputes', (req, res) => {
  try {
    const disputesRaw = db.prepare(`
      SELECT ir.*, o1.name as p1_name, o2.name as p2_name
      FROM issue_reports ir
      LEFT JOIN organizations o1 ON ir.reporter_org_id = o1.id
      LEFT JOIN organizations o2 ON ir.reported_org_id = o2.id
      WHERE ir.reporter_org_id IS NOT NULL AND ir.reported_org_id IS NOT NULL
      ORDER BY ir.created_at DESC
    `).all();

    const disputes = disputesRaw.map(d => ({
      id: d.id,
      type: d.issue_type || 'Dispute',
      party1: d.p1_name || 'Reporter Org',
      party2: d.p2_name || 'Respondent Org',
      description: d.description,
      status: d.status,
      createdAt: d.created_at
    }));

    res.json({ disputes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch disputes' });
  }
});

// ── PUT /api/admin/disputes/:id/resolve ────────────────────────────────────
router.put('/disputes/:id/resolve', (req, res) => {
  try {
    const { resolutionNotes } = req.body || {};
    db.prepare("UPDATE issue_reports SET status = 'resolved', resolution_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(resolutionNotes || 'Marked resolved by platform admin.', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve dispute' });
  }
});

// ── GET /api/admin/records ─────────────────────────────────────────────────
router.get('/records', (req, res) => {
  try {
    const recordsRaw = db.prepare(`
      SELECT vr.*, o.name as org_name, u.name as admin_name
      FROM verification_records vr
      LEFT JOIN organizations o ON vr.org_id = o.id
      LEFT JOIN users u ON vr.verified_by = u.id
      ORDER BY vr.created_at DESC LIMIT 50
    `).all();

    const records = recordsRaw.map(r => ({
      id: r.id,
      type: r.action,
      title: `${r.action.toUpperCase()} — ${r.org_name || 'Organization'}`,
      detail: r.notes || `Administrative record logged.`,
      admin: r.admin_name || 'Platform Administrator',
      createdAt: r.created_at
    }));

    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

// ── Org Action Endpoints (Called from admin dashboard modals) ───────────────
function handleOrgAction(action, newStatus, verifiedValue, req, res) {
  const orgId = req.params.id;
  const { notes, reason } = req.body || {};
  const noteText = notes || reason || `${action} by administrator`;

  try {
    if (newStatus) {
      db.prepare('UPDATE organizations SET status = ?, verified = ? WHERE id = ?')
        .run(newStatus, verifiedValue, orgId);
    }

    const recordId = uuidv4();
    db.prepare('INSERT INTO verification_records (id, org_id, verified_by, action, notes) VALUES (?, ?, ?, ?, ?)')
      .run(recordId, orgId, req.user.id, action, noteText);

    // Dispatch live notification to organization
    dispatchNotification({
      orgId,
      type: action === 'approve' || action === 'reinstate' ? 'success' : 'alert',
      title: `Organization Status: ${action.toUpperCase()}`,
      message: `Your organization has been ${action}d. Note: ${noteText}`
    });

    res.json({ success: true, action, newStatus });
  } catch (err) {
    console.error(`[Admin/${action} Error]`, err);
    res.status(500).json({ error: `Failed to execute ${action}` });
  }
}

router.put('/orgs/:id/approve',      (req, res) => handleOrgAction('approved', 'active', 1, req, res));
router.put('/orgs/:id/reject',       (req, res) => handleOrgAction('rejected', 'rejected', 0, req, res));
router.put('/orgs/:id/request-info', (req, res) => handleOrgAction('request_info', null, 0, req, res));
router.put('/orgs/:id/suspend',      (req, res) => handleOrgAction('suspended', 'suspended', 0, req, res));
router.put('/orgs/:id/reinstate',    (req, res) => handleOrgAction('reinstated', 'active', 1, req, res));
router.put('/orgs/:id/restrict',     (req, res) => handleOrgAction('restricted', 'restricted', 0, req, res));

// Legacy endpoints
router.get('/pending-verifications', (req, res) => {
  const pending = db.prepare("SELECT * FROM organizations WHERE status = 'pending' ORDER BY created_at ASC").all();
  res.json({ organizations: pending });
});

router.post('/verify/:orgId', (req, res) => {
  req.params.id = req.params.orgId;
  const action = req.body.action || 'approved';
  const statusMap = { approved: 'active', rejected: 'rejected', suspended: 'suspended', reinstated: 'active', restricted: 'restricted' };
  const verifiedMap = { approved: 1, reinstated: 1, rejected: 0, suspended: 0, restricted: 0 };
  handleOrgAction(action, statusMap[action] || 'active', verifiedMap[action] ?? 0, req, res);
});

// ── GET /api/admin/facilities ──────────────────────────────────────────────
router.get('/facilities', (req, res) => {
  try {
    const facilities = db.prepare(`
      SELECT * FROM biogas_facilities ORDER BY created_at DESC
    `).all();
    res.json({ facilities });
  } catch (err) {
    console.error('[Admin/Facilities]', err);
    res.status(500).json({ error: 'Failed to fetch facilities' });
  }
});

// ── POST /api/admin/facilities ────────────────────────────────────────────
router.post('/facilities', (req, res) => {
  try {
    const {
      name, locationAddress, locationLat, locationLng,
      contactPhone, contactEmail, operatingHours,
      acceptedWasteTypes, maxDailyIntakeKg, notes
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO biogas_facilities (id, name, location_address, location_lat, location_lng,
        contact_phone, contact_email, operating_hours, accepted_waste_types,
        max_daily_intake_kg, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      id, name, locationAddress || '', locationLat || 0, locationLng || 0,
      contactPhone || '', contactEmail || '',
      operatingHours || '',
      JSON.stringify(Array.isArray(acceptedWasteTypes) ? acceptedWasteTypes : []),
      maxDailyIntakeKg || 0, notes || ''
    );
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('[Admin/Facilities/POST]', err);
    res.status(500).json({ error: 'Failed to create facility' });
  }
});

// ── PUT /api/admin/facilities/:id ─────────────────────────────────────────
router.put('/facilities/:id', (req, res) => {
  try {
    const {
      name, locationAddress, locationLat, locationLng,
      contactPhone, contactEmail, operatingHours,
      acceptedWasteTypes, maxDailyIntakeKg, notes, status
    } = req.body;

    const facility = db.prepare('SELECT id FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });

    db.prepare(`
      UPDATE biogas_facilities SET
        name = COALESCE(?, name),
        location_address = COALESCE(?, location_address),
        location_lat = COALESCE(?, location_lat),
        location_lng = COALESCE(?, location_lng),
        contact_phone = COALESCE(?, contact_phone),
        contact_email = COALESCE(?, contact_email),
        operating_hours = COALESCE(?, operating_hours),
        accepted_waste_types = COALESCE(?, accepted_waste_types),
        max_daily_intake_kg = COALESCE(?, max_daily_intake_kg),
        notes = COALESCE(?, notes),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name || null, locationAddress || null, locationLat || null, locationLng || null,
      contactPhone || null, contactEmail || null, operatingHours || null,
      acceptedWasteTypes ? JSON.stringify(acceptedWasteTypes) : null,
      maxDailyIntakeKg != null ? maxDailyIntakeKg : null,
      notes || null, status || null,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/Facilities/PUT]', err);
    res.status(500).json({ error: 'Failed to update facility' });
  }
});

// ── PUT /api/admin/facilities/:id/verify ─────────────────────────────────
// "Verify" for facilities means activate — no verified flag gatekeeping.
router.put('/facilities/:id/verify', (req, res) => {
  try {
    const facility = db.prepare('SELECT id, name FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });

    db.prepare(`
      UPDATE biogas_facilities
      SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    db.prepare(`
      INSERT INTO verification_records (id, org_id, verified_by, action, notes)
      VALUES (?, ?, ?, 'approved', ?)
    `).run(uuidv4(), req.params.id, req.user.id, `Biogas/food-bank facility "${facility.name}" activated`);

    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/Facilities/Verify]', err);
    res.status(500).json({ error: 'Failed to activate facility' });
  }
});

// ── PUT /api/admin/facilities/:id/deactivate ──────────────────────────────
router.put('/facilities/:id/deactivate', (req, res) => {
  try {
    db.prepare(`
      UPDATE biogas_facilities SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate facility' });
  }
});

// ── GET /api/admin/map-data ───────────────────────────────────────────────
// Returns verified+active supply and demand points for the network map.
// Organizations: only verified=1 AND status='active' (donors, demand orgs, food banks).
// Biogas facilities: all with valid coordinates — not subject to the same
//   org verification flow, and the note says "unverified since we are not verifying them".
router.get('/map-data', (req, res) => {
  try {
    const orgsRaw = db.prepare(`
      SELECT id, name, type, location_lat, location_lng, location_address, status, verified,
             COALESCE(map_verified, 0) as map_verified
      FROM organizations
      WHERE location_lat != 0 AND location_lng != 0
        AND status = 'active'
        AND verified = 1
      ORDER BY type
    `).all();

    const organizations = orgsRaw.map(o => ({
      id: o.id,
      name: o.name,
      type: o.type,
      lat: o.location_lat,
      lng: o.location_lng,
      address: o.location_address,
      status: o.status,
      verified: !!o.verified,
      mapVerified: !!o.map_verified
    }));

    const facilitiesRaw = db.prepare(`
      SELECT id, name, location_lat, location_lng, location_address, status, verified,
             accepted_waste_types, max_daily_intake_kg
      FROM biogas_facilities
      WHERE location_lat != 0 AND location_lng != 0
      ORDER BY name
    `).all();

    const biogas_facilities = facilitiesRaw.map(f => ({
      id: f.id,
      name: f.name,
      lat: f.location_lat,
      lng: f.location_lng,
      address: f.location_address,
      status: f.status,
      verified: !!f.verified,
      acceptedWasteTypes: (() => { try { return JSON.parse(f.accepted_waste_types || '[]'); } catch { return []; } })(),
      maxDailyIntakeKg: f.max_daily_intake_kg
    }));

    res.json({ organizations, biogas_facilities });
  } catch (err) {
    console.error('[Admin/MapData]', err);
    res.status(500).json({ error: 'Failed to fetch map data' });
  }
});

// ── GET /api/admin/route-preview ─────────────────────────────────────────
// Returns road geometry (polyline) and ETA between two coordinates for map display.
// Uses getRouteWithGeometry so results are cached and the frontend never calls OSRM directly.
router.get('/route-preview', async (req, res) => {
  try {
    const oLat = parseFloat(req.query.oLat);
    const oLng = parseFloat(req.query.oLng);
    const dLat = parseFloat(req.query.dLat);
    const dLng = parseFloat(req.query.dLng);

    if ([oLat, oLng, dLat, dLng].some(v => isNaN(v))) {
      return res.status(400).json({ error: 'oLat, oLng, dLat, dLng are required numeric query params' });
    }

    const { getRouteWithGeometry } = require('../services/routing');
    const result = await getRouteWithGeometry(oLat, oLng, dLat, dLng);
    res.json(result);
  } catch (err) {
    console.error('[Admin/RoutePreview]', err);
    res.status(500).json({ error: 'Route preview unavailable' });
  }
});

// ── GET /api/admin/osm-discover ───────────────────────────────────────────
// Finds candidate facility locations from OSM via Nominatim using a search query.
// Results are suggestions only — admin must review and explicitly verify before use.
let lastOsmDiscoverMs = 0;
router.get('/osm-discover', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = (req.query.type || 'biogas').toLowerCase(); // 'biogas' or 'food_bank'
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    const now = Date.now();
    if (now - lastOsmDiscoverMs < 1200) {
      return res.status(429).json({ error: 'Rate limit: one discovery request per 1.2 seconds' });
    }
    lastOsmDiscoverMs = now;

    const { suggestLocations } = require('../services/geocoding');
    // Augment the query with the facility type keyword for better Nominatim results
    const typeKeyword = type === 'biogas' ? 'biogas plant' : 'food bank';
    const results = await suggestLocations(`${q} ${typeKeyword}`);

    // Shape results for admin review — explicitly label as unverified OSM suggestions
    const suggestions = results.map(r => ({
      display_name: r.display_name,
      lat: r.lat,
      lon: r.lon,
      importance: r.importance,
      source: 'openstreetmap_nominatim',
      verified: false,
      note: 'OSM suggestion — admin must verify location and details before adding to routing pool'
    }));

    res.json({ suggestions, type, query: q, count: suggestions.length });
  } catch (err) {
    console.error('[Admin/OsmDiscover]', err);
    res.status(500).json({ error: 'OSM discovery unavailable' });
  }
});

// ── GET /api/admin/geocode-suggest ───────────────────────────────────────
let lastGeocodeSuggestMs = 0;
router.get('/geocode-suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q parameter required' });

    const now = Date.now();
    if (now - lastGeocodeSuggestMs < 1100) {
      return res.status(429).json({ error: 'Rate limit: one geocode request per second' });
    }
    lastGeocodeSuggestMs = now;

    const suggestions = await suggestLocations(q);
    res.json({ suggestions });
  } catch (err) {
    console.error('[Admin/GeocodeSuggest]', err);
    res.status(500).json({ error: 'Geocoding service unavailable' });
  }
});

// ── PUT /api/admin/orgs/:id/map-verify ───────────────────────────────────
router.put('/orgs/:id/map-verify', (req, res) => {
  try {
    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    db.prepare('UPDATE organizations SET map_verified = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to map-verify organization' });
  }
});

// ── GET /api/admin/overpass-bounds ───────────────────────────────────────
// Queries the Overpass API for biogas/food-bank facilities inside given map
// bounds. Results are map-sourced only — they are NEVER inserted into the DB
// here; the client deduplicates by OSM ID client-side.
// Query params: south, west, north, east (floats), type ('biogas'|'food_bank')
let lastOverpassMs = 0;
router.get('/overpass-bounds', async (req, res) => {
  try {
    const south = parseFloat(req.query.south);
    const west  = parseFloat(req.query.west);
    const north = parseFloat(req.query.north);
    const east  = parseFloat(req.query.east);
    const type  = (req.query.type || 'biogas').toLowerCase();

    if ([south, west, north, east].some(v => isNaN(v))) {
      return res.status(400).json({ error: 'south, west, north, east are required numeric params' });
    }
    // Reject unreasonably large bounding boxes (>1° × 1° ≈ ~110 km²)
    if ((north - south) > 1 || (east - west) > 1) {
      return res.status(400).json({ error: 'Bounding box too large — zoom in further before discovering' });
    }

    // Simple in-process throttle: 1 request per 2 seconds across all users
    const now = Date.now();
    if (now - lastOverpassMs < 2000) {
      return res.status(429).json({ error: 'Rate limit: one Overpass request per 2 seconds' });
    }
    lastOverpassMs = now;

    // Build Overpass QL query. We search by tag combinations that reliably
    // identify biogas plants and food banks in OSM.
    const bbox = `${south},${west},${north},${east}`;
    let overpassQuery;
    if (type === 'biogas') {
      overpassQuery =
        `[out:json][timeout:15];` +
        `(` +
        `  node["plant:method"="anaerobic_digestion"](${bbox});` +
        `  way["plant:method"="anaerobic_digestion"](${bbox});` +
        `  node["power"="plant"]["plant:source"="biogas"](${bbox});` +
        `  way["power"="plant"]["plant:source"="biogas"](${bbox});` +
        `  node["amenity"="biogas"](${bbox});` +
        `  node["industrial"="biogas_plant"](${bbox});` +
        `)out center;`;
    } else {
      overpassQuery =
        `[out:json][timeout:15];` +
        `(` +
        `  node["social_facility"="food_bank"](${bbox});` +
        `  way["social_facility"="food_bank"](${bbox});` +
        `  node["amenity"="food_bank"](${bbox});` +
        `  node["social_facility"="soup_kitchen"](${bbox});` +
        `)out center;`;
    }

    const overpassBase = (process.env.OVERPASS_BASE_URL || 'https://overpass-api.de').replace(/\/$/, '');
    const url = `${overpassBase}/api/interpreter`;
    const postBody = `data=${encodeURIComponent(overpassQuery)}`;

    // POST to Overpass API
    const osmData = await new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'FoodBridge/1.0 (food-waste-reduction)'
        }
      };
      const req2 = mod.request(options, (response) => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`Overpass HTTP ${response.statusCode}`));
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Overpass JSON parse error: ' + e.message)); }
        });
      });
      req2.setTimeout(16000, () => { req2.destroy(); reject(new Error('Overpass request timed out')); });
      req2.on('error', reject);
      req2.write(postBody);
      req2.end();
    });

    // Normalise each OSM element to a flat result with lat/lng
    const results = (osmData.elements || []).map(el => {
      const lat = el.type === 'node' ? el.lat : (el.center ? el.center.lat : null);
      const lng = el.type === 'node' ? el.lon : (el.center ? el.center.lon : null);
      if (!lat || !lng) return null;
      const tags = el.tags || {};
      return {
        osmId:       el.id,
        osmType:     el.type,       // 'node' | 'way' | 'relation'
        lat,
        lng,
        name:        tags.name || tags['name:en'] || (type === 'biogas' ? 'Unnamed Biogas Plant' : 'Unnamed Food Bank'),
        address:     [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || null,
        phone:       tags.phone || tags['contact:phone'] || null,
        email:       tags.email || tags['contact:email'] || null,
        openingHours: tags.opening_hours || null,
        operator:    tags.operator || null,
        source:      'openstreetmap_overpass',
        mapSourced:  true,    // client must display with map-sourced label
        verified:    false    // never eligible for allocation until admin verifies
      };
    }).filter(Boolean);

    res.json({ results, count: results.length, bbox, type });
  } catch (err) {
    console.error('[Admin/OverpassBounds]', err);
    res.status(500).json({ error: 'Overpass discovery unavailable: ' + err.message });
  }
});

// ── PUT /api/admin/orgs/:id ───────────────────────────────────────────────
// Updates location/contact fields on an organization (used for food banks
// which live in the organizations table, not biogas_facilities).
router.put('/orgs/:id', (req, res) => {
  try {
    const {
      name, locationAddress, locationLat, locationLng,
      operatingHours, contactPhone, contactEmail, description, status
    } = req.body;

    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    db.prepare(`
      UPDATE organizations SET
        name             = COALESCE(?, name),
        location_address = COALESCE(?, location_address),
        location_lat     = COALESCE(?, location_lat),
        location_lng     = COALESCE(?, location_lng),
        operating_hours  = COALESCE(?, operating_hours),
        contact_phone    = COALESCE(?, contact_phone),
        contact_email    = COALESCE(?, contact_email),
        description      = COALESCE(?, description),
        status           = COALESCE(?, status)
      WHERE id = ?
    `).run(
      name || null,
      locationAddress || null,
      locationLat != null && !isNaN(locationLat) ? locationLat : null,
      locationLng != null && !isNaN(locationLng) ? locationLng : null,
      operatingHours || null,
      contactPhone || null,
      contactEmail || null,
      description || null,
      status || null,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Admin/Orgs/PUT]', err);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

module.exports = router;
