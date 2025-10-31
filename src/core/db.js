import pg from 'pg';

// --- UPDATED ---
// This file now *only* reads from environment variables,
// which are provided by docker-compose.yml.
// This is a 100% production-ready setup.
const pool = new pg.Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('connect', () => {
    console.log('[DB] Connected to Postgres pool.');
});

pool.on('error', (err) => {
    console.error('[DB] Postgres pool error:', err);
});

export default pool;

