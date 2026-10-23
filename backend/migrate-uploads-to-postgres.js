require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const fs = require('node:fs');
const path = require('node:path');
const uploadsDir = path.join(__dirname, 'uploads');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Set it in backend/.env before migrating uploads.');
  process.exit(1);
}
process.env.FOODBRIDGE_DATABASE_DRIVER = 'postgres';
const db = require('./database/db');

try {
  const files = fs.readdirSync(uploadsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== '.gitkeep')
    .map(entry => entry.name);
  let imported = 0;
  let alreadyPresent = 0;

  db.transaction(() => {
    for (const fileName of files) {
      const storageKey = path.basename(fileName);
      const existing = db.prepare('SELECT storage_key FROM stored_documents WHERE storage_key = ?').get(storageKey);
      if (existing) { alreadyPresent += 1; continue; }
      const data = fs.readFileSync(path.join(uploadsDir, fileName));
      const extension = path.extname(fileName).toLowerCase();
      const mimeType = extension === '.pdf' ? 'application/pdf'
        : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg'
          : extension === '.png' ? 'image/png' : 'application/octet-stream';
      db.prepare(`
        INSERT INTO stored_documents (storage_key, original_name, mime_type, data_base64)
        VALUES (?, ?, ?, ?)
      `).run(storageKey, fileName, mimeType, data.toString('base64'));
      imported += 1;
    }
  })();

  console.log(JSON.stringify({ migrated: true, imported, alreadyPresent }, null, 2));
} catch (error) {
  console.error(`[Upload migration] ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
