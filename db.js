const { Pool } = require('pg');

// Check if database is configured
const USE_DATABASE = !!process.env.DATABASE_URL;

// In-memory storage for local development
const memoryStore = {
  deals: null,
  companies: new Map(),
  meetings: new Map(),
  contacts: new Map(),
  pipelineStages: null,
  engagements: new Map(),
  nextSteps: new Map()
};

// Create PostgreSQL connection pool only if DATABASE_URL is set
let pool = null;
if (USE_DATABASE) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client', err);
  });
} else {
  console.log('Using in-memory storage (DATABASE_URL not configured)');
}

// Initialize database schema
async function initializeDatabase() {
  if (!USE_DATABASE) {
    console.log('In-memory storage initialized');
    return;
  }

  try {
    const client = await pool.connect();
    try {
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
          meeting_ids TEXT,
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

        CREATE TABLE IF NOT EXISTS company_engagements (
          id SERIAL PRIMARY KEY,
          company_id VARCHAR(255) NOT NULL,
          engagement_id VARCHAR(255) UNIQUE NOT NULL,
          engagement_type VARCHAR(50) NOT NULL,
          timestamp BIGINT NOT NULL,
          direction VARCHAR(20),
          content TEXT,
          metadata JSONB,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS deal_next_steps (
          deal_id VARCHAR(255) PRIMARY KEY,
          company_id VARCHAR(255) NOT NULL,
          next_step TEXT NOT NULL,
          last_engagement_timestamp BIGINT,
          generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_cache_companies_cached_at ON cache_companies(cached_at);
        CREATE INDEX IF NOT EXISTS idx_cache_meetings_cached_at ON cache_meetings(cached_at);
        CREATE INDEX IF NOT EXISTS idx_cache_contacts_cached_at ON cache_contacts(cached_at);
        CREATE INDEX IF NOT EXISTS idx_cache_deals_last_fetched ON cache_deals(last_fetched);
        CREATE INDEX IF NOT EXISTS idx_company_engagements_company_id ON company_engagements(company_id);
        CREATE INDEX IF NOT EXISTS idx_company_engagements_timestamp ON company_engagements(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_deal_next_steps_company_id ON deal_next_steps(company_id);
      `);

      // Migration: Add meeting_ids column if it doesn't exist
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'cache_meetings' AND column_name = 'meeting_ids'
          ) THEN
            ALTER TABLE cache_meetings ADD COLUMN meeting_ids TEXT;
          END IF;
        END $$;
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
  if (!USE_DATABASE) {
    return memoryStore.deals;
  }

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
  if (!USE_DATABASE) {
    memoryStore.deals = { data, lastFetched: Date.now() };
    return;
  }

  await pool.query('DELETE FROM cache_deals');
  await pool.query(
    'INSERT INTO cache_deals (data, last_fetched) VALUES ($1, NOW())',
    [JSON.stringify(data)]
  );
}

async function clearDealsCache() {
  if (!USE_DATABASE) {
    memoryStore.deals = null;
    return;
  }

  await pool.query('DELETE FROM cache_deals');
}

// Company cache operations
async function getCompanyCache(companyId, maxAgeMs) {
  if (!USE_DATABASE) {
    const cached = memoryStore.companies.get(companyId);
    if (!cached) return null;
    const age = Date.now() - cached.cachedAt;
    if (age > maxAgeMs) return null;
    return cached.data;
  }

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
  if (!USE_DATABASE) {
    memoryStore.companies.set(companyId, { data, cachedAt: Date.now() });
    return;
  }

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
  if (!USE_DATABASE) {
    const cached = memoryStore.meetings.get(companyId);
    if (!cached) return null;
    const age = Date.now() - cached.cachedAt;
    if (age > maxAgeMs) return null;
    return { lastMeetingDate: cached.lastMeetingDate, meetingIds: cached.meetingIds };
  }

  const result = await pool.query(
    'SELECT last_meeting_date, meeting_ids, cached_at FROM cache_meetings WHERE company_id = $1',
    [companyId]
  );

  if (result.rows.length === 0) return null;

  const cachedAt = new Date(result.rows[0].cached_at).getTime();
  const age = Date.now() - cachedAt;

  if (age > maxAgeMs) return null;

  return {
    lastMeetingDate: result.rows[0].last_meeting_date ? result.rows[0].last_meeting_date.toISOString() : null,
    meetingIds: result.rows[0].meeting_ids
  };
}

async function setMeetingCache(companyId, lastMeetingDate, meetingIds = null) {
  if (!USE_DATABASE) {
    memoryStore.meetings.set(companyId, { lastMeetingDate, meetingIds, cachedAt: Date.now() });
    return;
  }

  await pool.query(
    `INSERT INTO cache_meetings (company_id, last_meeting_date, meeting_ids, cached_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (company_id)
     DO UPDATE SET last_meeting_date = $2, meeting_ids = $3, cached_at = NOW()`,
    [companyId, lastMeetingDate, meetingIds]
  );
}

// Contact cache operations
async function getContactCache(contactId, maxAgeMs) {
  if (!USE_DATABASE) {
    const cached = memoryStore.contacts.get(contactId);
    if (!cached) return null;
    const age = Date.now() - cached.cachedAt;
    if (age > maxAgeMs) return null;
    return cached.data;
  }

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
  if (!USE_DATABASE) {
    memoryStore.contacts.set(contactId, { data, cachedAt: Date.now() });
    return;
  }

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
  if (!USE_DATABASE) {
    return memoryStore.pipelineStages;
  }

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
  if (!USE_DATABASE) {
    memoryStore.pipelineStages = { stagesMap, allStages };
    return;
  }

  await pool.query('DELETE FROM cache_pipeline_stages');
  await pool.query(
    'INSERT INTO cache_pipeline_stages (stages_map, all_stages, cached_at) VALUES ($1, $2, NOW())',
    [JSON.stringify(stagesMap), JSON.stringify(allStages)]
  );
}

// Clear all caches
async function clearAllCaches() {
  if (!USE_DATABASE) {
    memoryStore.deals = null;
    memoryStore.companies.clear();
    memoryStore.meetings.clear();
    memoryStore.contacts.clear();
    memoryStore.pipelineStages = null;
    memoryStore.engagements.clear();
    memoryStore.nextSteps.clear();
    return;
  }

  await pool.query('DELETE FROM cache_deals');
  await pool.query('DELETE FROM cache_companies');
  await pool.query('DELETE FROM cache_meetings');
  await pool.query('DELETE FROM cache_contacts');
  await pool.query('DELETE FROM cache_pipeline_stages');
}

// Get cache statistics
async function getCacheStats() {
  if (!USE_DATABASE) {
    return {
      deals: {
        cached: !!memoryStore.deals,
        lastFetched: memoryStore.deals ? new Date(memoryStore.deals.lastFetched).toISOString() : null,
        age: memoryStore.deals ? Date.now() - memoryStore.deals.lastFetched : null
      },
      companies: memoryStore.companies.size,
      meetings: memoryStore.meetings.size,
      contacts: memoryStore.contacts.size,
      pipelineStages: !!memoryStore.pipelineStages
    };
  }

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

// Engagement operations
async function saveEngagement(companyId, engagement) {
  if (!USE_DATABASE) {
    if (!memoryStore.engagements.has(companyId)) {
      memoryStore.engagements.set(companyId, []);
    }
    const engagements = memoryStore.engagements.get(companyId);
    const existingIndex = engagements.findIndex(e => e.id === engagement.id);
    if (existingIndex >= 0) {
      engagements[existingIndex] = engagement;
    } else {
      engagements.push(engagement);
    }
    return;
  }

  await pool.query(
    `INSERT INTO company_engagements (company_id, engagement_id, engagement_type, timestamp, direction, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (engagement_id) DO UPDATE
     SET content = $6, metadata = $7`,
    [
      companyId,
      engagement.id,
      engagement.type,
      engagement.timestamp,
      engagement.direction || null,
      engagement.content || null,
      JSON.stringify(engagement.metadata || {})
    ]
  );
}

async function getCompanyEngagements(companyId, limit = 10) {
  if (!USE_DATABASE) {
    const engagements = memoryStore.engagements.get(companyId) || [];
    return engagements.slice(0, limit);
  }

  const result = await pool.query(
    `SELECT * FROM company_engagements
     WHERE company_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [companyId, limit]
  );
  return result.rows;
}

async function getLastEngagementTimestamp(companyId) {
  if (!USE_DATABASE) {
    const engagements = memoryStore.engagements.get(companyId) || [];
    if (engagements.length === 0) return null;
    return Math.max(...engagements.map(e => e.timestamp));
  }

  const result = await pool.query(
    `SELECT MAX(timestamp) as last_timestamp
     FROM company_engagements
     WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0]?.last_timestamp || null;
}

// Next steps operations
async function saveNextStep(dealId, companyId, nextStep, lastEngagementTimestamp) {
  if (!USE_DATABASE) {
    memoryStore.nextSteps.set(dealId, {
      nextStep,
      lastEngagementTimestamp,
      generatedAt: new Date(),
      updatedAt: new Date()
    });
    return;
  }

  await pool.query(
    `INSERT INTO deal_next_steps (deal_id, company_id, next_step, last_engagement_timestamp, generated_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (deal_id)
     DO UPDATE SET next_step = $3, last_engagement_timestamp = $4, updated_at = NOW()`,
    [dealId, companyId, nextStep, lastEngagementTimestamp]
  );
}

async function getNextStep(dealId) {
  if (!USE_DATABASE) {
    const nextStep = memoryStore.nextSteps.get(dealId);
    if (!nextStep) return null;
    return {
      deal_id: dealId,
      next_step: nextStep.nextStep,
      last_engagement_timestamp: nextStep.lastEngagementTimestamp,
      generated_at: nextStep.generatedAt,
      updated_at: nextStep.updatedAt
    };
  }

  const result = await pool.query(
    'SELECT * FROM deal_next_steps WHERE deal_id = $1',
    [dealId]
  );
  return result.rows[0] || null;
}

async function getAllNextSteps() {
  if (!USE_DATABASE) {
    const nextSteps = {};
    memoryStore.nextSteps.forEach((value, dealId) => {
      nextSteps[dealId] = {
        nextStep: value.nextStep,
        lastEngagementTimestamp: value.lastEngagementTimestamp,
        generatedAt: value.generatedAt,
        updatedAt: value.updatedAt
      };
    });
    return nextSteps;
  }

  const result = await pool.query('SELECT * FROM deal_next_steps');
  const nextSteps = {};
  result.rows.forEach(row => {
    nextSteps[row.deal_id] = {
      nextStep: row.next_step,
      lastEngagementTimestamp: row.last_engagement_timestamp,
      generatedAt: row.generated_at,
      updatedAt: row.updated_at
    };
  });
  return nextSteps;
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
  getCacheStats,
  saveEngagement,
  getCompanyEngagements,
  getLastEngagementTimestamp,
  saveNextStep,
  getNextStep,
  getAllNextSteps
};
