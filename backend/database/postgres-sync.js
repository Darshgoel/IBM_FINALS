const path = require('node:path');
const { Worker } = require('node:worker_threads');

const RESPONSE_BYTES = 8 * 1024 * 1024;
const WAIT_TIMEOUT_MS = 60000;

function exchange(worker, message) {
  const shared = new SharedArrayBuffer(RESPONSE_BYTES);
  const state = new Int32Array(shared, 0, 2);
  worker.postMessage({ ...message, shared });
  const wait = Atomics.wait(state, 0, 0, WAIT_TIMEOUT_MS);
  if (wait === 'timed-out') throw new Error('Timed out waiting for the PostgreSQL database');
  const length = Atomics.load(state, 1);
  if (length < 2 || length > shared.byteLength - 8) throw new Error('Invalid response from the PostgreSQL worker');
  const response = JSON.parse(Buffer.from(shared, 8, length).toString('utf8'));
  if (response.error) {
    const error = new Error(response.error);
    error.code = response.code || undefined;
    throw error;
  }
  return response;
}

function translateSql(sql) {
  let translated = '';
  let parameterIndex = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      translated += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      translated += ch;
      if (ch === '*' && next === '/') { translated += next; i += 1; blockComment = false; }
      continue;
    }
    if (quote) {
      translated += ch;
      if (ch === quote && next === quote) { translated += next; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '-' && next === '-') { translated += ch + next; i += 1; lineComment = true; continue; }
    if (ch === '/' && next === '*') { translated += ch + next; i += 1; blockComment = true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; translated += ch; continue; }
    if (ch === '?') { parameterIndex += 1; translated += `$${parameterIndex}`; continue; }
    translated += ch;
  }

  // SQLite's date() is parsed as a type cast by PostgreSQL, so route it to the
  // compatibility function created by postgres-worker.js.
  return translated
    .replace(/\bdate\s*\(/gi, 'sqlite_date(')
    .replace(/\bstrftime\s*\(/gi, 'sqlite_strftime(')
    .replace(/\browid\b/gi, 'id')
    .replace(/\bifnull\s*\(/gi, 'COALESCE(');
}

function normalizeParams(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Buffer.isBuffer(args[0]) && !(args[0] instanceof Date)) {
    throw new Error('Named SQLite parameters are not supported by the PostgreSQL adapter; use positional parameters.');
  }
  return args;
}

function createPostgresSyncDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL mode');

  const readyShared = new SharedArrayBuffer(RESPONSE_BYTES);
  const state = new Int32Array(readyShared, 0, 2);
  const worker = new Worker(path.join(__dirname, 'postgres-worker.js'), {
    workerData: { connectionString, readyShared }
  });
  const ready = Atomics.wait(state, 0, 0, WAIT_TIMEOUT_MS);
  if (ready === 'timed-out') {
    worker.terminate();
    throw new Error('Timed out connecting to the PostgreSQL database');
  }
  const readyLength = Atomics.load(state, 1);
  const readyResult = JSON.parse(Buffer.from(readyShared, 8, readyLength).toString('utf8'));
  if (!readyResult.ready) {
    worker.terminate();
    throw new Error(`PostgreSQL initialization failed: ${readyResult.error || 'unknown error'}`);
  }

  const db = {
    prepare(sql) {
      const pgSql = translateSql(sql);
      return {
        get(...args) { return exchange(worker, { action: 'query', sql: pgSql, params: normalizeParams(args) }).rows[0]; },
        all(...args) { return exchange(worker, { action: 'query', sql: pgSql, params: normalizeParams(args) }).rows; },
        run(...args) {
          const result = exchange(worker, { action: 'query', sql: pgSql, params: normalizeParams(args) });
          return { changes: result.rowCount, lastInsertRowid: undefined };
        }
      };
    },
    exec(sql) { exchange(worker, { action: 'query', sql: String(sql), params: [] }); return db; },
    pragma() { return undefined; },
    transaction(callback) {
      return (...args) => {
        exchange(worker, { action: 'begin' });
        try {
          const result = callback(...args);
          if (result && typeof result.then === 'function') throw new Error('PostgreSQL compatibility transactions must remain synchronous');
          exchange(worker, { action: 'commit' });
          return result;
        } catch (error) {
          try { exchange(worker, { action: 'rollback' }); } catch {}
          throw error;
        }
      };
    },
    close() { exchange(worker, { action: 'close' }); worker.terminate(); }
  };

  return db;
}

module.exports = { createPostgresSyncDatabase, translateSql };
