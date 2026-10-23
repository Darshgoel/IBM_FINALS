const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { dispatchNotification } = require('../services/notifications');
const { parseDocumentData, storeDocument } = require('../services/document-storage');

const router = express.Router();
const PARTNER_ROLES = ['donor', 'demand_org', 'food_bank', 'biogas_operator'];

router.use(authenticate, requireRole(...PARTNER_ROLES));

function entityForUser(user) {
  if (user.role === 'biogas_operator') {
    return user.biogasFacilityId ? { id: user.biogasFacilityId, kind: 'biogas' } : null;
  }
  return user.orgId ? { id: user.orgId, kind: 'organization' } : null;
}

function currentInfoRequest(entityId) {
  const request = db.prepare(`
    SELECT id, notes, created_at
    FROM verification_records
    WHERE org_id = ? AND action = 'request_info'
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(entityId);
  if (!request) return null;
  const response = db.prepare(`
    SELECT response_text, document_name, document_url, created_at
    FROM partner_verification_responses
    WHERE request_record_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(request.id);
  return {
    id: request.id,
    notes: request.notes || '',
    createdAt: request.created_at,
    response: response ? {
      text: response.response_text || '',
      documentName: response.document_name || '',
      documentUrl: response.document_url || '',
      createdAt: response.created_at
    } : null
  };
}

router.get('/', (req, res) => {
  try {
    const entity = entityForUser(req.user);
    if (!entity) return res.status(404).json({ error: 'Partner organization or facility was not found' });
    const request = currentInfoRequest(entity.id);
    res.json({ request });
  } catch (err) {
    console.error('[PartnerVerification/Get]', err);
    res.status(500).json({ error: 'Could not load verification requests' });
  }
});

router.post('/respond', (req, res) => {
  try {
    const entity = entityForUser(req.user);
    if (!entity) return res.status(404).json({ error: 'Partner organization or facility was not found' });

    const request = db.prepare(`
      SELECT id, notes FROM verification_records
      WHERE org_id = ? AND action = 'request_info'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(entity.id);
    if (!request) return res.status(404).json({ error: 'There is no open information request to respond to' });

    const priorResponse = db.prepare(`
      SELECT id FROM partner_verification_responses WHERE request_record_id = ? LIMIT 1
    `).get(request.id);
    if (priorResponse) return res.status(409).json({ error: 'You have already responded to this information request' });

    const responseText = String(req.body?.message || '').trim();
    const documentName = String(req.body?.documentName || '').trim();
    const documentData = String(req.body?.documentData || '');
    if (!responseText && !documentData) {
      return res.status(400).json({ error: 'Add a response or attach a supporting document' });
    }
    if (responseText.length > 4000) return res.status(400).json({ error: 'Response must be 4,000 characters or fewer' });

    let storedDocument = null;
    let documentUrl = '';
    let safeDocumentName = '';
    if (documentData || documentName) {
      if (!documentData || !documentName) return res.status(400).json({ error: 'Attach both a file and its filename' });
      const extension = path.extname(documentName).toLowerCase();
      if (!['.pdf', '.jpg', '.jpeg', '.png'].includes(extension)) {
        return res.status(400).json({ error: 'Use a PDF, JPG, JPEG, or PNG document' });
      }
      const base64 = documentData.includes(';base64,') ? documentData.split(';base64,').pop() : documentData;
      try { parseDocumentData(base64); }
      catch { return res.status(400).json({ error: 'Supporting documents must be smaller than 4 MB' }); }
      safeDocumentName = documentName.replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    const responseId = uuidv4();
    const auditRecordId = uuidv4();
    const auditNotes = responseText || `Supporting document submitted: ${safeDocumentName}`;
    db.transaction(() => {
      if (documentData) {
        storedDocument = storeDocument({ fileName: documentName, fileData: documentData, keyPrefix: 'verification' });
        documentUrl = storedDocument.url;
      }
      db.prepare(`
        INSERT INTO verification_records (id, org_id, verified_by, action, notes)
        VALUES (?, ?, ?, 'info_response', ?)
      `).run(auditRecordId, entity.id, req.user.id, auditNotes);
      db.prepare(`
        INSERT INTO partner_verification_responses
          (id, request_record_id, entity_id, response_text, document_name, document_url, submitted_by, audit_record_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(responseId, request.id, entity.id, responseText, safeDocumentName, documentUrl, req.user.id, auditRecordId);
    })();

    const partnerName = entity.kind === 'biogas'
      ? db.prepare('SELECT name FROM biogas_facilities WHERE id = ?').get(entity.id)?.name
      : db.prepare('SELECT name FROM organizations WHERE id = ?').get(entity.id)?.name;
    dispatchNotification({
      role: 'admin',
      type: 'info',
      title: 'Partner responded to verification request',
      message: `${partnerName || 'A partner'} submitted a response for the requested information.`
    });

    res.status(201).json({ success: true, response: { id: responseId, message: responseText, documentName: safeDocumentName, documentUrl } });
  } catch (err) {
    console.error('[PartnerVerification/Respond]', err);
    res.status(500).json({ error: 'Could not submit your verification response' });
  }
});

module.exports = router;
