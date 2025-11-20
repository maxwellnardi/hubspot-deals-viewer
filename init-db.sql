-- HubSpot Deals Viewer Database Schema

-- Table for caching deal data
CREATE TABLE IF NOT EXISTS cache_deals (
    id SERIAL PRIMARY KEY,
    data JSONB NOT NULL,
    last_fetched TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Table for caching company data
CREATE TABLE IF NOT EXISTS cache_companies (
    company_id VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    cached_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Table for caching meeting data
CREATE TABLE IF NOT EXISTS cache_meetings (
    company_id VARCHAR(255) PRIMARY KEY,
    last_meeting_date TIMESTAMP,
    cached_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Table for caching contact data
CREATE TABLE IF NOT EXISTS cache_contacts (
    contact_id VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    cached_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Table for caching pipeline stages
CREATE TABLE IF NOT EXISTS cache_pipeline_stages (
    id SERIAL PRIMARY KEY,
    stages_map JSONB NOT NULL,
    all_stages JSONB NOT NULL,
    cached_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_cache_companies_cached_at ON cache_companies(cached_at);
CREATE INDEX IF NOT EXISTS idx_cache_meetings_cached_at ON cache_meetings(cached_at);
CREATE INDEX IF NOT EXISTS idx_cache_contacts_cached_at ON cache_contacts(cached_at);
CREATE INDEX IF NOT EXISTS idx_cache_deals_last_fetched ON cache_deals(last_fetched);

-- Keep only the most recent deals cache entry (cleanup old entries)
CREATE OR REPLACE FUNCTION cleanup_old_deals_cache()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM cache_deals
    WHERE id NOT IN (
        SELECT id FROM cache_deals
        ORDER BY last_fetched DESC
        LIMIT 1
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_old_deals_cache
AFTER INSERT ON cache_deals
FOR EACH ROW
EXECUTE FUNCTION cleanup_old_deals_cache();

-- Keep only the most recent pipeline stages cache entry
CREATE OR REPLACE FUNCTION cleanup_old_pipeline_stages_cache()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM cache_pipeline_stages
    WHERE id NOT IN (
        SELECT id FROM cache_pipeline_stages
        ORDER BY cached_at DESC
        LIMIT 1
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_old_pipeline_stages_cache
AFTER INSERT ON cache_pipeline_stages
FOR EACH ROW
EXECUTE FUNCTION cleanup_old_pipeline_stages_cache();
