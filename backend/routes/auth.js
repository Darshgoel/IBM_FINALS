const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');

const router = express.Router();

const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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

    if (!['donor', 'demand_org', 'recipient'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be donor, demand_org, or recipient' });
    }

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

    const result = db.transaction(() => {
      // Handle document storage if provided
      let finalDocUrl = existingDocUrl || '';
      let finalDocName = documentName || '';

      if (documentData && documentName) {
        const cleanName = documentName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `doc_${Date.now()}_${cleanName}`;
        const filePath = path.join(uploadsDir, filename);

        // Strip data:image/...;base64, or data:application/pdf;base64, header if present
        const base64Data = documentData.includes(';base64,') ? documentData.split(';base64,')[1] : documentData;
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

        finalDocUrl = `/uploads/${filename}`;
        finalDocName = documentName;
      }

      // Create organization for donor and demand_org
      if (role !== 'recipient' && orgName) {
        orgId = uuidv4();
        db.prepare(`
        INSERT INTO organizations (id, name, type, location_address, location_lat, location_lng, operating_hours, contact_phone, contact_email, description, status, document_url, document_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          orgId, orgName, orgType || role, locationAddress || '',
          locationLat || 0, locationLng || 0, operatingHours || '',
          contactPhone || '', normalizedEmail, description || '',
          finalDocUrl, finalDocName
        );

        if (finalDocUrl) {
          db.prepare(`
          INSERT INTO organization_documents (id, org_id, file_name, file_path, doc_type)
          VALUES (?, ?, ?, ?, 'verification_certificate')
          `).run(uuidv4(), orgId, finalDocName, finalDocUrl);
        }

        if (role === 'donor') {
          db.prepare('INSERT INTO donor_profiles (org_id) VALUES (?)').run(orgId);
        } else if (role === 'demand_org') {
          db.prepare('INSERT INTO demand_org_profiles (org_id) VALUES (?)').run(orgId);
        }
      }

      db.prepare(`
      INSERT INTO users (id, email, password_hash, role, org_id, name) VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, normalizedEmail, passwordHash, role, orgId, name);

      const token = jwt.sign(
        { id: userId, email: normalizedEmail, role, orgId, name },
        jwtSecret,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      return {
        token,
        user: { id: userId, email: normalizedEmail, name, role, orgId },
        documentUploaded: !!finalDocUrl
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

    const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const savedName = `doc_${Date.now()}_${cleanName}`;
    const filePath = path.join(uploadsDir, savedName);

    const base64Data = fileData.includes(';base64,') ? fileData.split(';base64,')[1] : fileData;
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    res.json({
      success: true,
      documentUrl: `/uploads/${savedName}`,
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

    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

    const jwtSecret = process.env.JWT_SECRET || 'foodbridge-local-development-secret-change-me';
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, orgId: user.org_id, name: user.name },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.org_id } });
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
