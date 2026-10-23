const path = require('node:path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database/db');

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
};

function parseDocumentData(value) {
  if (typeof value !== 'string' || !value) throw new Error('Document data is required');
  const base64 = value.includes(';base64,') ? value.split(';base64,').pop() : value;
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error('Documents must be smaller than 4 MB');
  }
  return bytes;
}

function storeDocument({ fileName, fileData, keyPrefix = 'doc' }) {
  const safeName = String(fileName || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeName) throw new Error('A valid filename is required');
  const bytes = parseDocumentData(fileData);
  const storageKey = `${keyPrefix}_${uuidv4()}_${safeName}`;
  const mimeType = MIME_TYPES[path.extname(safeName).toLowerCase()] || 'application/octet-stream';
  db.prepare(`
    INSERT INTO stored_documents (storage_key, original_name, mime_type, data_base64)
    VALUES (?, ?, ?, ?)
  `).run(storageKey, fileName, mimeType, bytes.toString('base64'));
  return { storageKey, safeName, mimeType, size: bytes.length, url: `/uploads/${storageKey}` };
}

function getDocument(storageKey) {
  return db.prepare(`
    SELECT original_name, mime_type, data_base64
    FROM stored_documents WHERE storage_key = ?
  `).get(storageKey);
}

module.exports = { MAX_DOCUMENT_BYTES, parseDocumentData, storeDocument, getDocument };
