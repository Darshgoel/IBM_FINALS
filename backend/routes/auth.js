const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { storeDocument } = require('../services/document-storage');

const router = express.Router();

// POST /api/auth/register
router.post('/register', (req, res) => {
  try {
    const {
      email, password, name, role, orgName, orgType,
      locationAddress, locationLat, locationLng, operatingHours, contactPhone, description,
      documentName, documentData, documentUrl: existingDocUrl
    } = req.body;

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedEmail || !password || !name || !role) {
      return res.status(400).json({ error: 'Email, password, name and role are required' });
    }

    if (!['donor', 'demand_org', 'recipient', 'food_bank', 'biogas_operator'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be donor, demand_org, recipient, food_bank, or biogas_operator' });
    }

    if (role === 'donor' && (!documentName || !documentData)) {
      return res.status(400).json({ error: 'A valid FSSAI licence document is required to register as a food donor' });
    }

    const autoApprovalSetting = db.prepare(
      'SELECT setting_value FROM platform_settings WHERE setting_key = ?'
    ).get('automatic_organization_approval');
    const autoApproveOrganization = autoApprovalSetting?.setting_value === 'true';

    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // Do not write anything if token creation cannot succeed. In development a
    // local fallback keeps the app usable without requiring a .env file; set a
    // real JWT_SECRET in production.
    const jwtSecret = process.env.JWT_SECRET ||
      (process.env.NODE_ENV === 'production' ? null : 'foodbridge-local-development-secret-change-me');
    if (!jwtSecret) {
      return res.status(500).json({ error: 'Server authentication is not configured' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const userId = uuidv4();
    let orgId = null;
    let autoApproved = false;

    const result = db.transaction(() => {
      // Handle document storage if provided
      let finalDocUrl = existingDocUrl || '';
      let finalDocName = documentName || '';

      if (documentData && documentName) {
        const stored = storeDocument({ fileName: documentName, fileData: documentData });
        finalDocUrl = stored.url;
        finalDocName = documentName;
      }

      // Create organization for donor, demand_org, and food_bank
      if (!['recipient', 'biogas_operator'].includes(role) && orgName) {
        orgId = uuidv4();
        const organizationStatus = autoApproveOrganization ? 'active' : 'pending';
        db.prepare(`
        INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, document_url, document_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orgId, orgName, orgType || role, locationAddress || '',
          locationLat || 0, locationLng || 0, operatingHours || '',
          contactPhone || '', normalizedEmail, description || '',
          organizationStatus, finalDocUrl, finalDocName
        );
        if (autoApproveOrganization) {
          db.prepare('UPDATE organizations SET verified = 1 WHERE id = ?').run(orgId);
          db.prepare(`
            INSERT INTO verification_records (id, org_id, verified_by, action, notes)
            VALUES (?, ?, NULL, 'approved', ?)
          `).run(uuidv4(), orgId, 'Automatically approved at registration by the administrator setting.');
          autoApproved = true;
        }

        if (finalDocUrl) {
          db.prepare(`
          INSERT INTO organization_documents (id, org_id, file_name, file_path, doc_type)
          VALUES (?, ?, ?, ?, 'verification_certificate')
          `).run(uuidv4(), orgId, finalDocName, finalDocUrl);
        }

        if (role === 'donor') {
          db.prepare('INSERT INTO donor_profiles (org_id) VALUES (?)').run(orgId);
        } else if (role === 'demand_org' || role === 'food_bank') {
          db.prepare('INSERT INTO demand_org_profiles (org_id) VALUES (?)').run(orgId);
        }
      }

      // biogas_operator: link or create a biogas facility record
      let biogasFacilityId = req.body.biogasFacilityId || null;
      if (role === 'biogas_operator') {
        if (biogasFacilityId) {
          // Claim an existing unowned facility
          const facility = db.prepare('SELECT id, operator_user_id FROM biogas_facilities WHERE id = ?').get(biogasFacilityId);
          if (!facility) throw new Error('Biogas facility not found');
          if (facility.operator_user_id) throw new Error('That facility already has an operator account');
          // Ownership is linked after user insertion; automatic approval still
          // applies to the claimed facility when the administrator enabled it.
          if (autoApproveOrganization) {
            db.prepare("UPDATE biogas_facilities SET status = 'active', verified = 1 WHERE id = ?").run(biogasFacilityId);
            db.prepare(`
              INSERT INTO verification_records (id, org_id, verified_by, action, notes)
              VALUES (?, ?, NULL, 'approved', ?)
            `).run(uuidv4(), biogasFacilityId, 'Automatically approved at registration by the administrator setting.');
            autoApproved = true;
          }
        } else if (orgName) {
          // Register a brand-new facility
          biogasFacilityId = uuidv4();
          const facilityStatus = autoApproveOrganization ? 'active' : 'pending';
          const facilityVerified = autoApproveOrganization ? 1 : 0;
          db.prepare(`
            INSERT INTO biogas_facilities
              (id, name, location_address, location_lat, location_lng, contact_phone, contact_email,
               operating_hours, accepted_waste_types, max_daily_intake_kg, status, verified, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            biogasFacilityId,
            orgName,
            locationAddress || '',
            locationLat || 0,
            locationLng || 0,
            contactPhone || '',
            normalizedEmail,
            operatingHours || '',
            req.body.acceptedWasteTypes ? JSON.stringify(req.body.acceptedWasteTypes) : '[]',
            req.body.maxDailyIntakeKg || 0,
            facilityStatus,
            facilityVerified,
            description || 'Biogas operator registered through FoodBridge public site.'
          );
          if (autoApproveOrganization) {
            db.prepare(`
              INSERT INTO verification_records (id, org_id, verified_by, action, notes)
              VALUES (?, ?, NULL, 'approved', ?)
            `).run(uuidv4(), biogasFacilityId, 'Automatically approved at registration by the administrator setting.');
            autoApproved = true;
          }
        }
      }

      db.prepare(`
      INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, normalizedEmail, passwordHash, role, orgId, name);

      // Link facility ownership for biogas operators
      if (role === 'biogas_operator' && biogasFacilityId) {
        db.prepare('UPDATE biogas_facilities SET operator_user_id = ? WHERE id = ?').run(userId, biogasFacilityId);
      }

      const token = jwt.sign(
        { id: userId, email: normalizedEmail, role, orgId, name, biogasFacilityId: biogasFacilityId || undefined },
        jwtSecret,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      return {
        token,
        user: { id: userId, email: normalizedEmail, name, role, orgId, biogasFacilityId: biogasFacilityId || undefined },
        documentUploaded: !!finalDocUrl,
        autoApproved
      };
    })();

    res.status(201).json(result);
  } catch (err) {
    console.error('[Auth/Register]', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/upload - Direct document upload endpoint
router.post('/upload', (req, res) => {
  try {
    const { fileName, fileData } = req.body;
    if (!fileName || !fileData) {
      return res.status(400).json({ error: 'fileName and fileData are required' });
    }

    const stored = storeDocument({ fileName, fileData });

    res.json({
      success: true,
      documentUrl: stored.url,
      documentName: fileName
    });
  } catch (err) {
    console.error('[Auth/Upload]', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Role separation: admins / operators may only sign in through the ops
    // portal (scope 'ops'); public accounts may only sign in through the
    // shared sign-in on the FoodBridge home page (scope 'user'). Logins
    // without an explicit scope keep the legacy unrestricted behaviour.
    const OPS_ROLES = ['admin', 'network_admin', 'network_intelligence'];
    const scope = req.body.scope;
    if (scope === 'ops' && !OPS_ROLES.includes(user.role)) {
      return res.status(403).json({
        error: 'This sign-in is restricted to FoodBridge admins and operators. Public accounts must sign in from the FoodBridge home page.'
      });
    }
    if (scope === 'user' && OPS_ROLES.includes(user.role)) {
      return res.status(403).json({
        error: 'Admin and operator accounts cannot sign in here. Please use "Sign in as Admin" on the ops portal.'
      });
    }

    // Rejected biogas registrations must not create a fresh session. Pending
    // operators may sign in to review their facility profile, while operational
    // API actions remain blocked until an administrator activates the facility.
    if (user.role === 'biogas_operator') {
      const facility = db.prepare('SELECT status FROM biogas_facilities WHERE operator_user_id = ? LIMIT 1').get(user.id);
      if (facility?.status === 'rejected') {
        return res.status(403).json({ error: 'This biogas facility registration was rejected. Contact FoodBridge support for next steps.' });
      }
    }

    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

    // Look up linked biogas facility for operators
    let biogasFacilityId = null;
    if (user.role === 'biogas_operator') {
      const fac = db.prepare('SELECT id FROM biogas_facilities WHERE operator_user_id = ? LIMIT 1').get(user.id);
      if (fac) biogasFacilityId = fac.id;
    }

    const jwtSecret = process.env.JWT_SECRET || 'foodbridge-local-development-secret-change-me';
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, orgId: user.org_id, name: user.name, biogasFacilityId: biogasFacilityId || undefined },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.org_id, biogasFacilityId: biogasFacilityId || undefined } });
  } catch (err) {
    console.error('[Auth/Login]', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
const { authenticate } = require('../middleware/auth');
router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role, org_id, created_at, last_login FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let org = null;
  if (user.org_id) {
    org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(user.org_id);
  }

  res.json({ user, org });
});

module.exports = router;
