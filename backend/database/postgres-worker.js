const { parentPort, workerData } = require('node:worker_threads');
const { Pool, types } = require('pg');

types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));

const connectionUrl = new URL(workerData.connectionString);
connectionUrl.searchParams.delete('sslmode');
const pool = new Pool({
  connectionString: connectionUrl.toString(),
  ssl: { rejectUnauthorized: true },
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

let transactionClient = null;

async function installSqliteDateHelpers() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.datetime(value text, modifier text DEFAULT NULL)
    RETURNS text LANGUAGE plpgsql VOLATILE AS $$
    DECLARE stamp timestamp without time zone;
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      IF lower(value) = 'now' THEN
        stamp := clock_timestamp() AT TIME ZONE 'UTC';
      ELSE
        stamp := value::timestamptz AT TIME ZONE 'UTC';
      END IF;
      IF modifier IS NOT NULL THEN stamp := stamp + modifier::interval; END IF;
      RETURN to_char(stamp, 'YYYY-MM-DD HH24:MI:SS');
    EXCEPTION WHEN OTHERS THEN RETURN NULL;
    END $$;

    CREATE OR REPLACE FUNCTION public.sqlite_date(value text, modifier text DEFAULT NULL)
    RETURNS text LANGUAGE plpgsql VOLATILE AS $$
    DECLARE stamp timestamp without time zone;
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      IF lower(value) = 'now' THEN
        stamp := clock_timestamp() AT TIME ZONE 'UTC';
      ELSE
        stamp := value::timestamptz AT TIME ZONE 'UTC';
      END IF;
      IF modifier IS NOT NULL THEN stamp := stamp + modifier::interval; END IF;
      RETURN to_char(stamp, 'YYYY-MM-DD');
    EXCEPTION WHEN OTHERS THEN RETURN NULL;
    END $$;

    CREATE OR REPLACE FUNCTION public.julianday(value text)
    RETURNS double precision LANGUAGE plpgsql VOLATILE AS $$
    DECLARE stamp timestamptz;
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      IF lower(value) = 'now' THEN stamp := clock_timestamp();
      ELSE stamp := value::timestamptz; END IF;
      RETURN (extract(epoch FROM stamp) / 86400.0) + 2440587.5;
    EXCEPTION WHEN OTHERS THEN RETURN NULL;
    END $$;

    CREATE OR REPLACE FUNCTION public.sqlite_strftime(format text, value text)
    RETURNS text LANGUAGE plpgsql VOLATILE AS $$
    DECLARE stamp timestamp without time zone; pg_format text;
    BEGIN
      IF value IS NULL THEN RETURN NULL; END IF;
      IF lower(value) = 'now' THEN stamp := clock_timestamp() AT TIME ZONE 'UTC';
      ELSE stamp := value::timestamptz AT TIME ZONE 'UTC'; END IF;
      IF format = '%w' THEN RETURN (extract(dow FROM stamp)::integer)::text; END IF;
      pg_format := replace(format, '%Y', 'YYYY');
      pg_format := replace(pg_format, '%m', 'MM');
      pg_format := replace(pg_format, '%d', 'DD');
      pg_format := replace(pg_format, '%H', 'HH24');
      pg_format := replace(pg_format, '%M', 'MI');
      pg_format := replace(pg_format, '%S', 'SS');
      RETURN to_char(stamp, pg_format);
    EXCEPTION WHEN OTHERS THEN RETURN NULL;
    END $$;
  `);
}

function respond(shared, value) {
  const view = new Int32Array(shared, 0, 2);
  const bytes = Buffer.from(JSON.stringify(value));
  const capacity = shared.byteLength - 8;
  if (bytes.length > capacity) {
    const error = Buffer.from(JSON.stringify({ error: 'Database result exceeded the synchronous adapter response limit' }));
    error.copy(Buffer.from(shared, 8));
    Atomics.store(view, 1, error.length);
  } else {
    bytes.copy(Buffer.from(shared, 8));
    Atomics.store(view, 1, bytes.length);
  }
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
}

async function start() {
  try {
    await installSqliteDateHelpers();
    respond(workerData.readyShared, { ready: true });
  } catch (error) {
    respond(workerData.readyShared, { ready: false, error: error.message });
    return;
  }

  parentPort.on('message', async message => {
    const { shared, action } = message;
    try {
      if (action === 'begin') {
        if (transactionClient) throw new Error('Nested database transactions are not supported');
        transactionClient = await pool.connect();
        await transactionClient.query('BEGIN');
        respond(shared, { ok: true });
        return;
      }
      if (action === 'commit' || action === 'rollback') {
        if (transactionClient) {
          try { await transactionClient.query(action === 'commit' ? 'COMMIT' : 'ROLLBACK'); }
          finally { transactionClient.release(); transactionClient = null; }
        }
        respond(shared, { ok: true });
        return;
      }
      if (action === 'close') {
        if (transactionClient) {
          try { await transactionClient.query('ROLLBACK'); } finally { transactionClient.release(); transactionClient = null; }
        }
        await pool.end();
        respond(shared, { ok: true });
        return;
      }

      const client = transactionClient || pool;
      const result = await client.query(message.sql, message.params || []);
      const results = Array.isArray(result) ? result : [result];
      const finalResult = results[results.length - 1] || { rows: [], rowCount: 0, command: '' };
      respond(shared, {
        ok: true,
        rows: finalResult.rows || [],
        rowCount: finalResult.rowCount || 0,
        command: finalResult.command || ''
      });
    } catch (error) {
      respond(shared, { error: error.message, code: error.code || null });
    }
  });
}

start();
