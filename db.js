const { Pool } = require('pg');

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

// Initialize database schema
async function initializeDatabase() {
  try {
    const client = await pool.connect();
    try {
      // Create tables if they don't exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS cache_deals (
          id SERIAL PRIMARY KEY,
          data JSONB NOT NULL,
          last_fetched TIMESTAMP NOT NULL DEFAULT NOW(),
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS cache_companies (
          company_id VARCHAR(255) PRIMARY KEY,
          data JSONB NOT NULL,
          cached_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS cache_meetings (
          company_id VARCHAR(255) PRIMARY KEY,
          last_meeting_date TIMESTAMP,
          cached_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS cache_contacts (
          contact_id VARCHAR(255) PRIMARY KEY,
          data JSONB NOT NULL,
          cached_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS cache_pipeline_stages (
          id SERIAL PRIMARY KEY,
          stages_map JSONB NOT NULL,
          all_stages JSONB NOT NULL,
          cached_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_cache_companies_cached_at ON cache_companies(cached_at);
        CREATE INDEX IF NOT EXISTS idx_cache_meetings_cached_at ON cache_meetings(cached_at);
        CREATE INDEX IF NOT EXISTS idx_cache_contacts_cached_at ON cache_contacts(cached_at);
        CREATE INDEX IF NOT EXISTS idx_cache_deals_last_fetched ON cache_deals(last_fetched);
      `);
      console.log('Database schema initialized successfully');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// Deals cache operations
async function getDealsCache() {
  const result = await pool.query(
    'SELECT data, last_fetched FROM cache_deals ORDER BY last_fetched DESC LIMIT 1'
  );
  if (result.rows.length === 0) return null;
  return {
    data: result.rows[0].data,
    lastFetched: new Date(result.rows[0].last_fetched).getTime()
  };
}

async function setDealsCache(data) {
  // Delete old entries and insert new one
  await pool.query('DELETE FROM cache_deals');
  await pool.query(
    'INSERT INTO cache_deals (data, last_fetched) VALUES ($1, NOW())',
    [JSON.stringify(data)]
  );
}

async function clearDealsCache() {
  await pool.query('DELETE FROM cache_deals');
}

// Company cache operations
async function getCompanyCache(companyId, maxAgeMs) {
  const result = await pool.query(
    'SELECT data, cached_at FROM cache_companies WHERE company_id = $1',
    [companyId]
  );

  if (result.rows.length === 0) return null;

  const cachedAt = new Date(result.rows[0].cached_at).getTime();
  const age = Date.now() - cachedAt;

  if (age > maxAgeMs) return null;

  return result.rows[0].data;
}

async function setCompanyCache(companyId, data) {
  await pool.query(
    `INSERT INTO cache_companies (company_id, data, cached_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id)
     DO UPDATE SET data = $2, cached_at = NOW()`,
    [companyId, JSON.stringify(data)]
  );
}

// Meeting cache operations
async function getMeetingCache(companyId, maxAgeMs) {
  const result = await pool.query(
    'SELECT last_meeting_date, cached_at FROM cache_meetings WHERE company_id = $1',
    [companyId]
  );

  if (result.rows.length === 0) return null;

  const cachedAt = new Date(result.rows[0].cached_at).getTime();
  const age = Date.now() - cachedAt;

  if (age > maxAgeMs) return null;

  return result.rows[0].last_meeting_date ? result.rows[0].last_meeting_date.toISOString() : null;
}

async function setMeetingCache(companyId, lastMeetingDate) {
  await pool.query(
    `INSERT INTO cache_meetings (company_id, last_meeting_date, cached_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id)
     DO UPDATE SET last_meeting_date = $2, cached_at = NOW()`,
    [companyId, lastMeetingDate]
  );
}

// Contact cache operations
async function getContactCache(contactId, maxAgeMs) {
  const result = await pool.query(
    'SELECT data, cached_at FROM cache_contacts WHERE contact_id = $1',
    [contactId]
  );

  if (result.rows.length === 0) return null;

  const cachedAt = new Date(result.rows[0].cached_at).getTime();
  const age = Date.now() - cachedAt;

  if (age > maxAgeMs) return null;

  return result.rows[0].data;
}

async function setContactCache(contactId, data) {
  await pool.query(
    `INSERT INTO cache_contacts (contact_id, data, cached_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (contact_id)
     DO UPDATE SET data = $2, cached_at = NOW()`,
    [contactId, JSON.stringify(data)]
  );
}

// Pipeline stages cache operations
async function getPipelineStagesCache() {
  const result = await pool.query(
    'SELECT stages_map, all_stages FROM cache_pipeline_stages ORDER BY cached_at DESC LIMIT 1'
  );

  if (result.rows.length === 0) return null;

  return {
    stagesMap: result.rows[0].stages_map,
    allStages: result.rows[0].all_stages
  };
}

async function setPipelineStagesCache(stagesMap, allStages) {
  await pool.query('DELETE FROM cache_pipeline_stages');
  await pool.query(
    'INSERT INTO cache_pipeline_stages (stages_map, all_stages, cached_at) VALUES ($1, $2, NOW())',
    [JSON.stringify(stagesMap), JSON.stringify(allStages)]
  );
}

// Clear all caches
async function clearAllCaches() {
  await pool.query('DELETE FROM cache_deals');
  await pool.query('DELETE FROM cache_companies');
  await pool.query('DELETE FROM cache_meetings');
  await pool.query('DELETE FROM cache_contacts');
  await pool.query('DELETE FROM cache_pipeline_stages');
}

// Get cache statistics
async function getCacheStats() {
  const deals = await pool.query('SELECT COUNT(*) as count, MAX(last_fetched) as last_fetched FROM cache_deals');
  const companies = await pool.query('SELECT COUNT(*) as count FROM cache_companies');
  const meetings = await pool.query('SELECT COUNT(*) as count FROM cache_meetings');
  const contacts = await pool.query('SELECT COUNT(*) as count FROM cache_contacts');
  const pipelines = await pool.query('SELECT COUNT(*) as count FROM cache_pipeline_stages');

  return {
    deals: {
      cached: parseInt(deals.rows[0].count) > 0,
      lastFetched: deals.rows[0].last_fetched ? deals.rows[0].last_fetched.toISOString() : null,
      age: deals.rows[0].last_fetched ? Date.now() - new Date(deals.rows[0].last_fetched).getTime() : null
    },
    companies: parseInt(companies.rows[0].count),
    meetings: parseInt(meetings.rows[0].count),
    contacts: parseInt(contacts.rows[0].count),
    pipelineStages: parseInt(pipelines.rows[0].count) > 0
  };
}

module.exports = {
  pool,
  initializeDatabase,
  getDealsCache,
  setDealsCache,
  clearDealsCache,
  getCompanyCache,
  setCompanyCache,
  getMeetingCache,
  setMeetingCache,
  getContactCache,
  setContactCache,
  getPipelineStagesCache,
  setPipelineStagesCache,
  clearAllCaches,
  getCacheStats
};
