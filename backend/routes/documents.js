const express = require('express');
const { getDocument } = require('../services/document-storage');

const router = express.Router();

router.get('/:storageKey', (req, res) => {
  try {
    const document = getDocument(req.params.storageKey);
    if (!document) return res.status(404).json({ error: 'Document not found' });

    const bytes = Buffer.from(document.data_base64, 'base64');
    const safeName = String(document.original_name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.set({
      'Content-Type': document.mime_type || 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store'
    });
    return res.send(bytes);
  } catch (error) {
    console.error('[Documents/Get]', error);
    return res.status(500).json({ error: 'Could not load document' });
  }
});

module.exports = router;
