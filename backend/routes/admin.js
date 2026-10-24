const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');
const { storeDocument } = require('../services/document-storage');

const router = express.Router();

router.use(authenticate);
router.use(requireRole('admin'));

const AUTO_APPROVAL_SETTING = 'automatic_organization_approval';
const BENGALURU_DEMO_NGO_SEED_SETTING = 'bengaluru_demo_ngos_seeded_v1';

const BENGALURU_DEMO_NGOS = [
  { name: 'Demo NGO 01 - Jayanagar Community Meals', area: 'Jayanagar', lat: 12.925, lng: 77.584 },
  { name: 'Demo NGO 02 - Shivajinagar Relief Network', area: 'Shivajinagar', lat: 12.985, lng: 77.604 },
  { name: 'Demo NGO 03 - Mahadevapura Family Support', area: 'Mahadevapura', lat: 12.991, lng: 77.696 },
  { name: 'Demo NGO 04 - Basavanagudi Food Collective', area: 'Basavanagudi', lat: 12.942, lng: 77.569 },
  { name: 'Demo NGO 05 - Marathahalli Community Aid', area: 'Marathahalli', lat: 12.956, lng: 77.701 },
  { name: 'Demo NGO 06 - Rajarajeshwari Nagar Outreach', area: 'Rajarajeshwari Nagar', lat: 12.927, lng: 77.520 }
];

function demoPlaceholderPdfBase64(organizationName, kind) {
  const safeName = String(organizationName).replace(/[^A-Za-z0-9 ,.-]/g, '').slice(0, 70);
  const verificationNotice = kind === 'donor'
    ? '(NOT A VALID FSSAI LICENCE)'
    : '(DEMO PLACEHOLDER - NOT A REAL CERTIFICATE)';
  const stream = [
    'BT', '/F1 22 Tf', '72 700 Td', '(DEMO ONLY) Tj',
    '/F1 14 Tf', '0 -34 Td', verificationNotice + ' Tj',
    '/F1 11 Tf', '0 -42 Td', `(${safeName}) Tj`,
    '0 -24 Td', '(Placeholder document for FoodBridge testing.) Tj',
    'ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'ascii').toString('base64');
}

router.post('/demo/seed-bengaluru-ngos', (req, res) => {
  try {
    const alreadySeeded = db.prepare('SELECT setting_value FROM platform_settings WHERE setting_key = ?')
      .get(BENGALURU_DEMO_NGO_SEED_SETTING);
    if (alreadySeeded?.setting_value === 'true') {
      return res.status(409).json({ error: 'The six Bengaluru demo NGOs have already been created. Credentials were shown only once.' });
    }

    const emailPrefix = 'foodbridge-demo-bengaluru-ngo-';
    const existing = db.prepare('SELECT email FROM users WHERE email LIKE ?').all(`${emailPrefix}%@example.com`);
    if (existing.length) {
      return res.status(409).json({ error: 'Some Bengaluru demo NGO emails already exist. No accounts were created; contact an administrator to avoid duplicates.' });
    }

    const credentials = db.transaction(() => {
      const created = [];
      BENGALURU_DEMO_NGOS.forEach((ngo, index) => {
        const number = String(index + 1).padStart(2, '0');
        const email = `${emailPrefix}${number}@example.com`;
        const password = `FbDemo-${crypto.randomBytes(9).toString('base64url')}`;
        const userId = uuidv4();
        const orgId = uuidv4();
        const documentName = `DEMO_ONLY_NGO_PLACEHOLDER_${number}.pdf`;
        const document = storeDocument({
          fileName: documentName,
          fileData: demoPlaceholderPdfBase64(ngo.name, 'ngo')
        });

        db.prepare(`
          INSERT INTO organizations
            (id, name, type, location_address, location_lat, location_lng, contact_email,
             description, status, verified, document_url, document_name)
          VALUES (?, ?, 'ngo', ?, ?, ?, ?, ?, 'active', 1, ?, ?)
        `).run(orgId, ngo.name, `${ngo.area}, Bengaluru, Karnataka`, ngo.lat, ngo.lng, email,
          'Synthetic FoodBridge test NGO. Automatically approved for the Bengaluru demo; attached PDF is a generic demo placeholder.',
          document.url, documentName);
        db.prepare(`
          INSERT INTO organization_documents (id, org_id, file_name, file_path, doc_type, file_size)
          VALUES (?, ?, ?, ?, 'demo_placeholder', ?)
        `).run(uuidv4(), orgId, documentName, document.url, document.size);
        db.prepare('INSERT INTO demand_org_profiles (org_id) VALUES (?)').run(orgId);
        db.prepare('INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, email, bcrypt.hashSync(password, 10), 'demand_org', orgId, `NGO Demo Coordinator ${number}`);
        db.prepare(`
          INSERT INTO verification_records (id, org_id, verified_by, action, notes)
          VALUES (?, ?, NULL, 'approved', ?)
        `).run(uuidv4(), orgId,
          'Automatically approved at registration for the Bengaluru demo NGO seed. Attached PDF is a generic placeholder, not a valid compliance certificate.');

        created.push({
          type: 'NGO', name: ngo.name, area: ngo.area, email, password,
          document: documentName, status: 'active — automatically approved'
        });
      });
      db.prepare(`
        INSERT INTO platform_settings (setting_key, setting_value, updated_by, updated_at)
        VALUES (?, 'true', ?, CURRENT_TIMESTAMP)
      `).run(BENGALURU_DEMO_NGO_SEED_SETTING, req.user.id);
      return created;
    })();

    res.status(201).json({ created: credentials, autoApproved: true, message: 'Six demo NGOs created and approved. Save these credentials now; they are not stored in plain text.' });
  } catch (err) {
    console.error('[Admin/DemoSeed/BengaluruNGOs]', err);
    res.status(500).json({ error: 'Could not create the six Bengaluru demo NGOs' });
  }
});

router.get('/settings/auto-approval', (req, res) => {
  try {
    const setting = db.prepare('SELECT setting_value, updated_at FROM platform_settings WHERE setting_key = ?')
      .get(AUTO_APPROVAL_SETTING);
    res.json({ enabled: setting?.setting_value === 'true', updatedAt: setting?.updated_at || null });
  } catch (err) {
    console.error('[Admin/AutoApproval/GET]', err);
    res.status(500).json({ error: 'Failed to load automatic approval setting' });
  }
});

router.put('/settings/auto-approval', (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const value = req.body.enabled ? 'true' : 'false';
    db.prepare(`
      INSERT INTO platform_settings (setting_key, setting_value, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(AUTO_APPROVAL_SETTING, value, req.user.id);
    res.json({ enabled: req.body.enabled });
  } catch (err) {
    console.error('[Admin/AutoApproval/PUT]', err);
    res.status(500).json({ error: 'Failed to update automatic approval setting' });
  }
});

// Helper to format role from org type
function orgRole(type) {
  if (['restaurant', 'hotel', 'caterer', 'retailer', 'institution', 'donor', 'other_donor'].includes(type)) {
    return 'donor';
  }
  return 'demand_org';
}

function verificationExchange(entityId) {
  const request = db.prepare(`
    SELECT id, notes, created_at FROM verification_records
    WHERE org_id = ? AND action = 'request_info'
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(entityId);
  if (!request) return {};
  const response = db.prepare(`
    SELECT response_text, document_name, document_url, created_at
    FROM partner_verification_responses WHERE request_record_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(request.id);
  return {
    infoRequestNotes: request.notes || '',
    infoRequestAt: request.created_at,
    infoResponseNotes: response?.response_text || '',
    infoResponseDocumentName: response?.document_name || '',
    infoResponseDocumentUrl: response?.document_url || '',
    infoResponseAt: response?.created_at || ''
  };
}

// ── GET /api/admin/overview ────────────────────────────────────────────────
router.get('/overview', (req, res) => {
  try {
    const pending = db.prepare("SELECT COUNT(*) as c FROM organizations WHERE status = 'pending'").get().c
      + db.prepare("SELECT COUNT(*) as c FROM biogas_facilities WHERE status = 'pending'").get().c;
    const verified = db.prepare("SELECT COUNT(*) as c FROM organizations WHERE status = 'active' AND verified = 1").get().c
      + db.prepare("SELECT COUNT(*) as c FROM biogas_facilities WHERE status = 'active' AND verified = 1").get().c;
    const suspended = db.prepare("SELECT COUNT(*) as c FROM organizations WHERE status = 'suspended'").get().c
      + db.prepare("SELECT COUNT(*) as c FROM biogas_facilities WHERE status = 'suspended'").get().c;
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

    const recentPendingOrganizations = pendingRaw.map(o => ({
      id: o.id,
      name: o.name,
      orgName: o.name,
      role: o.user_role || orgRole(o.type),
      type: o.type,
      _kind: 'org',
      locationAddress: o.location_address,
      email: o.contact_email || o.user_email,
      servingCapacity: o.serving_capacity,
      status: o.status,
      documentUrl: o.document_url || '',
      documentName: o.document_name || '',
      createdAt: o.created_at,
      ...verificationExchange(o.id)
    }));

    const pendingBiogasRaw = db.prepare(`
      SELECT bf.*, u.email AS user_email, u.name AS user_name
      FROM biogas_facilities bf
      LEFT JOIN users u ON u.id = bf.operator_user_id
      WHERE bf.status = 'pending'
      ORDER BY bf.created_at DESC LIMIT 5
    `).all();
    const recentPendingBiogas = pendingBiogasRaw.map(f => ({
      id: f.id,
      name: f.name,
      orgName: f.name,
      role: 'biogas_operator',
      type: 'biogas',
      _kind: 'biogas',
      locationAddress: f.location_address,
      email: f.contact_email || f.user_email || '',
      operatorName: f.user_name || '',
      maxDailyIntakeKg: f.max_daily_intake_kg || 0,
      status: f.status,
      documentUrl: f.document_url || '',
      documentName: f.document_name || '',
      createdAt: f.created_at,
      ...verificationExchange(f.id)
    }));
    const recentPending = [...recentPendingOrganizations, ...recentPendingBiogas]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 5);

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
      SELECT vr.*, COALESCE(o.name, bf.name) as org_name, u.name as admin_name
      FROM verification_records vr
      LEFT JOIN organizations o ON vr.org_id = o.id
      LEFT JOIN biogas_facilities bf ON vr.org_id = bf.id
      LEFT JOIN users u ON vr.verified_by = u.id
      ORDER BY vr.created_at DESC LIMIT 8
    `).all();

    const recentActions = recordsRaw.map(r => ({
      id: r.id,
      type: r.action,
      title: `Action: ${r.action.toUpperCase()} — ${r.org_name || 'Organization'}`,
      detail: r.notes || `Administrative ${r.action} recorded.`,
      admin: r.notes?.startsWith('Automatically approved at registration')
        ? 'Automatic approval'
        : (r.admin_name || 'Platform Administrator'),
      createdAt: r.created_at
    }));

    res.json({
      pendingCount: pending,
      verifiedCount: verified,
      flaggedCount: flags.c,
      disputeCount: disputes.c || flags.c,
      suspendedCount: suspended,
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
// Returns all four account types awaiting review:
//   donor, demand_org, food_bank  → organizations table (status = 'pending')
//   biogas_operator               → biogas_facilities table (status = 'pending') + linked user
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
      _kind: 'org',
      locationAddress: o.location_address,
      locationLat: o.location_lat,
      locationLng: o.location_lng,
      email: o.contact_email || o.user_email,
      servingCapacity: o.serving_capacity,
      status: 'pending',
      documentUrl: o.document_url || '',
      documentName: o.document_name || '',
      createdAt: o.created_at,
      ...verificationExchange(o.id)
    }));

    // Biogas operators: pending facility joined with its linked operator user
    const biogasRaw2 = db.prepare(`
      SELECT bf.*,
             u.id as user_id, u.email as user_email, u.name as user_name
      FROM biogas_facilities bf
      LEFT JOIN users u ON u.id = bf.operator_user_id
      WHERE bf.status = 'pending'
      ORDER BY bf.created_at ASC
    `).all();

    const biogasOrgs = biogasRaw2.map(f => ({
      id: f.id,
      name: f.name,
      orgName: f.name,
      role: 'biogas_operator',
      type: 'biogas',
      _kind: 'biogas',
      locationAddress: f.location_address,
      locationLat: f.location_lat,
      locationLng: f.location_lng,
      email: f.contact_email || f.user_email || '',
      contactPhone: f.contact_phone || '',
      operatingHours: f.operating_hours || '',
      acceptedWasteTypes: (() => { try { return JSON.parse(f.accepted_waste_types || '[]'); } catch { return []; } })(),
      maxDailyIntakeKg: f.max_daily_intake_kg || 0,
      operatorUserId: f.operator_user_id || f.user_id || null,
      operatorName: f.user_name || '',
      status: 'pending',
      documentUrl: f.document_url || '',
      documentName: f.document_name || '',
      createdAt: f.created_at,
      ...verificationExchange(f.id)
    }));

    res.json({ orgs: [...orgs, ...biogasOrgs] });
  } catch (err) {
    console.error('[Admin/Pending]', err);
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

    const biogasRaw = db.prepare(`
      SELECT bf.*, u.email AS user_email, u.name AS user_name
      FROM biogas_facilities bf
      LEFT JOIN users u ON u.id = bf.operator_user_id
      ORDER BY bf.created_at DESC
    `).all();
    const biogasPartners = biogasRaw.map(f => ({
      id: f.id,
      name: f.name,
      orgName: f.name,
      role: 'biogas_operator',
      type: 'biogas',
      _kind: 'biogas',
      locationAddress: f.location_address,
      locationLat: f.location_lat,
      locationLng: f.location_lng,
      email: f.contact_email || f.user_email || '',
      contactPhone: f.contact_phone || '',
      operatingHours: f.operating_hours || '',
      acceptedWasteTypes: (() => { try { return JSON.parse(f.accepted_waste_types || '[]'); } catch { return []; } })(),
      maxDailyIntakeKg: f.max_daily_intake_kg || 0,
      operatorUserId: f.operator_user_id || null,
      operatorName: f.user_name || '',
      verified: !!f.verified,
      status: f.status === 'active' && f.verified ? 'verified' : f.status,
      documentUrl: f.document_url || '',
      documentName: f.document_name || '',
      createdAt: f.created_at
    }));

    res.json({ orgs: [...orgs, ...biogasPartners].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) });
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
      SELECT vr.*, COALESCE(o.name, bf.name) as org_name, u.name as admin_name,
             COALESCE(pvr.document_url, o.document_url, '') AS document_url,
             COALESCE(pvr.document_name, o.document_name, '') AS document_name
      FROM verification_records vr
      LEFT JOIN organizations o ON vr.org_id = o.id
      LEFT JOIN biogas_facilities bf ON vr.org_id = bf.id
      LEFT JOIN users u ON vr.verified_by = u.id
      LEFT JOIN partner_verification_responses pvr ON pvr.audit_record_id = vr.id
      ORDER BY vr.created_at DESC LIMIT 50
    `).all();

    const records = recordsRaw.map(r => ({
      id: r.id,
      type: r.action === 'info_response' ? 'partner_response' : r.action,
      title: `${r.action.toUpperCase()} — ${r.org_name || 'Organization'}`,
      detail: r.notes || `Administrative record logged.`,
      admin: r.action === 'info_response'
        ? (r.org_name || 'Partner organization')
        : (r.notes?.startsWith('Automatically approved at registration')
          ? 'Automatic approval'
          : (r.admin_name || 'Platform Administrator')),
      createdAt: r.created_at,
      documentUrl: r.document_url || '',
      documentName: r.document_name || ''
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
      title: action === 'request_info' ? 'Additional information requested' : `Organization Status: ${action.toUpperCase()}`,
      message: action === 'request_info'
        ? `Please respond to the verification request in your partner dashboard: ${noteText}`
        : `Your organization has been ${action}d. Note: ${noteText}`
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

function handleBiogasStatusAction(action, status, req, res) {
  try {
    const facility = db.prepare('SELECT id, name FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Biogas facility not found' });
    const notes = (req.body?.notes || `${action} by administrator`).trim();
    db.transaction(() => {
      db.prepare('UPDATE biogas_facilities SET status = ?, verified = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(status, status === 'active' ? 1 : 0, facility.id);
      db.prepare('INSERT INTO verification_records (id, org_id, verified_by, action, notes) VALUES (?, ?, ?, ?, ?)')
        .run(uuidv4(), facility.id, req.user.id, action, notes);
    })();
    res.json({ success: true, action, status });
  } catch (err) {
    console.error(`[Admin/Biogas/${action}]`, err);
    res.status(500).json({ error: `Failed to ${action} biogas partner` });
  }
}

router.put('/biogas/:id/suspend',  (req, res) => handleBiogasStatusAction('suspended', 'suspended', req, res));
router.put('/biogas/:id/reinstate', (req, res) => handleBiogasStatusAction('reinstated', 'active', req, res));
router.put('/biogas/:id/restrict',  (req, res) => handleBiogasStatusAction('restricted', 'restricted', req, res));

// ── PUT /api/admin/biogas/:id/approve ────────────────────────────────────
// Approves a pending biogas_operator registration by activating its facility.
router.put('/biogas/:id/approve', (req, res) => {
  try {
    const { notes } = req.body || {};
    const facility = db.prepare('SELECT id, name, operator_user_id FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Biogas facility not found' });

    db.prepare(`UPDATE biogas_facilities SET status = 'active', verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(facility.id);

    db.prepare(`INSERT INTO verification_records (id, org_id, verified_by, action, notes) VALUES (?, ?, ?, 'approved', ?)`)
      .run(uuidv4(), facility.id, req.user.id, notes || `Biogas operator "${facility.name}" approved by administrator`);

    res.json({ success: true, action: 'approved' });
  } catch (err) {
    console.error('[Admin/Biogas/Approve]', err);
    res.status(500).json({ error: 'Failed to approve biogas operator' });
  }
});

// ── PUT /api/admin/biogas/:id/reject ─────────────────────────────────────
router.put('/biogas/:id/reject', (req, res) => {
  try {
    const { notes } = req.body || {};
    const facility = db.prepare('SELECT id, name, operator_user_id FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Biogas facility not found' });

    db.prepare(`UPDATE biogas_facilities SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(facility.id);

    db.prepare(`INSERT INTO verification_records (id, org_id, verified_by, action, notes) VALUES (?, ?, ?, 'rejected', ?)`)
      .run(uuidv4(), facility.id, req.user.id, notes || `Biogas operator "${facility.name}" rejected by administrator`);

    res.json({ success: true, action: 'rejected' });
  } catch (err) {
    console.error('[Admin/Biogas/Reject]', err);
    res.status(500).json({ error: 'Failed to reject biogas operator' });
  }
});

// ── PUT /api/admin/biogas/:id/request-info ────────────────────────────────
router.put('/biogas/:id/request-info', (req, res) => {
  try {
    const { notes } = req.body || {};
    const facility = db.prepare('SELECT id, name, operator_user_id FROM biogas_facilities WHERE id = ?').get(req.params.id);
    if (!facility) return res.status(404).json({ error: 'Biogas facility not found' });

    db.prepare(`INSERT INTO verification_records (id, org_id, verified_by, action, notes) VALUES (?, ?, ?, 'request_info', ?)`)
      .run(uuidv4(), facility.id, req.user.id, notes || `Additional information requested for "${facility.name}"`);

    dispatchNotification({
      userId: facility.operator_user_id || null,
      type: 'alert',
      title: 'Additional information requested',
      message: `Please respond to the verification request in your partner dashboard: ${notes || `Additional information requested for "${facility.name}"`}`
    });

    res.json({ success: true, action: 'request_info' });
  } catch (err) {
    console.error('[Admin/Biogas/RequestInfo]', err);
    res.status(500).json({ error: 'Failed to log info request' });
  }
});

module.exports = router;
