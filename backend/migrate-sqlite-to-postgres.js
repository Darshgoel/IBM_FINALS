require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const path = require('node:path');
const Database = require('better-sqlite3');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Set it in backend/.env before running this migration.');
  process.exit(1);
}

const sourcePath = process.env.FOODBRIDGE_SQLITE_SOURCE
  ? path.resolve(process.env.FOODBRIDGE_SQLITE_SOURCE)
  : process.env.FOODBRIDGE_DB_PATH
    ? path.resolve(process.env.FOODBRIDGE_DB_PATH)
    : path.join(__dirname, 'database', 'foodbridge.db');

const target = require('./database/db');
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
source.pragma('busy_timeout = 10000');

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

try {
  const tables = source.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);

  const targetTables = new Set(target.prepare(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `).all().map(row => row.table_name));
  const missing = tables.filter(table => !targetTables.has(table));
  if (missing.length) throw new Error(`PostgreSQL schema is missing tables: ${missing.join(', ')}`);

  const existing = tables
    .map(table => ({ table, count: Number(target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count) }))
    .filter(row => row.count > 0);
  if (existing.length) {
    throw new Error(`Migration stopped safely because PostgreSQL already contains data: ${existing.map(row => `${row.table}=${row.count}`).join(', ')}`);
  }

  const rowsByTable = new Map(tables.map(table => [table, source.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all()]));
  const migrated = target.transaction(() => {
    const counts = {};
    for (const table of tables) {
      const rows = rowsByTable.get(table);
      if (!rows.length) { counts[table] = 0; continue; }

      const columns = Object.keys(rows[0]);
      const params = [];
      const values = rows.map(row => {
        const offset = params.length;
        params.push(...columns.map(column => row[column]));
        return `(${columns.map((_, index) => `$${offset + index + 1}`).join(', ')})`;
      });
      const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${values.join(', ')}`;
      target.prepare(sql).run(params);
      counts[table] = rows.length;
    }
    return counts;
  })();

  console.log(JSON.stringify({ migrated: true, source: path.basename(sourcePath), tables: migrated }, null, 2));
} catch (error) {
  console.error(`[SQLite to PostgreSQL] ${error.message}`);
  process.exitCode = 1;
} finally {
  source.close();
  target.close();
}
