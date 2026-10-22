const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');

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
      email: o.contact_email || o.user_email,
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

module.exports = router;
