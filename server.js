require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const db = require('./db');
const nextSteps = require('./nextSteps');

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

app.use(express.static('public'));
app.use(express.json());

// Determine if using Developer API key (legacy) or Private App token
const isPrivateAppToken = HUBSPOT_ACCESS_TOKEN && HUBSPOT_ACCESS_TOKEN.startsWith('pat-');

const hubspotApi = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    'Content-Type': 'application/json',
    ...(isPrivateAppToken && { 'Authorization': `Bearer ${HUBSPOT_ACCESS_TOKEN}` })
  }
});

// Add Developer API key to all requests if not using Private App token
if (!isPrivateAppToken) {
  hubspotApi.interceptors.request.use((config) => {
    config.params = config.params || {};
    config.params.hapikey = HUBSPOT_ACCESS_TOKEN;
    return config;
  });
}

async function getLastMeetingDate(companyId) {
  // Check cache first
  const cached = await db.getMeetingCache(companyId, CACHE_ITEM_DURATION);
  if (cached !== null) {
    return cached;
  }

  try {
    const response = await hubspotApi.get(`/crm/v3/objects/companies/${companyId}/associations/meetings`);

    if (!response.data.results || response.data.results.length === 0) {
      await db.setMeetingCache(companyId, null);
      return null;
    }

    const meetingIds = response.data.results.map(m => m.id);

    // Process meetings in smaller batches to avoid rate limits
    const meetings = await processBatch(
      meetingIds,
      async (id) => {
        try {
          const meetingResponse = await hubspotApi.get(`/crm/v3/objects/meetings/${id}`, {
            params: { properties: 'hs_timestamp,hs_meeting_title,hs_meeting_start_time' }
          });
          return meetingResponse.data;
        } catch (error) {
          console.error(`Error fetching meeting ${id}:`, error.message);
          return null;
        }
      },
      5, // Smaller batch size for meetings
      500 // Shorter delay
    );

    const meetingDates = meetings
      .filter(m => m !== null)
      .map(m => {
        const props = m.properties;
        return props.hs_meeting_start_time || props.hs_timestamp;
      })
      .filter(date => date)
      .map(date => new Date(date));

    if (meetingDates.length === 0) {
      await db.setMeetingCache(companyId, null);
      return null;
    }

    const lastMeetingDate = new Date(Math.max(...meetingDates));
    const lastMeetingDateISO = lastMeetingDate.toISOString();
    await db.setMeetingCache(companyId, lastMeetingDateISO);
    return lastMeetingDateISO;

  } catch (error) {
    console.error(`Error fetching meetings for company ${companyId}:`, error.response?.data || error.message);
    return null;
  }
}

// In-memory flag to track if refresh is in progress
let isRefreshing = false;

const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes (increased from 5)
const CACHE_ITEM_DURATION = 60 * 60 * 1000; // 1 hour for individual items

// Rate limiting: Process requests in batches with delays
const BATCH_SIZE = 10; // Process 10 items at a time
const BATCH_DELAY = 1000; // 1 second delay between batches

// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to process items in batches with delay
async function processBatch(items, processFn, batchSize = BATCH_SIZE, delayMs = BATCH_DELAY) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);

    // Add delay between batches (except for last batch)
    if (i + batchSize < items.length) {
      await delay(delayMs);
    }
  }
  return results;
}

async function getPipelineStages() {
  // Check cache first
  const cached = await db.getPipelineStagesCache();
  if (cached) {
    return cached;
  }

  try {
    const response = await hubspotApi.get('/crm/v3/pipelines/deals');
    const pipelines = response.data.results;

    const stagesMap = {};
    pipelines.forEach(pipeline => {
      pipeline.stages.forEach(stage => {
        stagesMap[stage.id] = {
          label: stage.label,
          displayOrder: stage.displayOrder,
          pipelineId: pipeline.id
        };
      });
    });

    const result = {
      stagesMap,
      allStages: pipelines.flatMap(p => p.stages.map(s => ({
        id: s.id,
        label: s.label,
        displayOrder: s.displayOrder,
        pipelineId: p.id,
        pipelineLabel: p.label
      }))).sort((a, b) => a.displayOrder - b.displayOrder)
    };

    await db.setPipelineStagesCache(result.stagesMap, result.allStages);
    return result;
  } catch (error) {
    console.error('Error fetching pipeline stages:', error.response?.data || error.message);
    return { stagesMap: {}, allStages: [] };
  }
}

app.get('/api/stages', async (req, res) => {
  try {
    const stages = await getPipelineStages();
    res.json(stages.allStages);
  } catch (error) {
    console.error('Error fetching stages:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch deal stages from HubSpot',
      details: error.response?.data || error.message
    });
  }
});

// Function to fetch all deal details
async function fetchAllDeals() {
  console.log('Fetching all deals...');

  const dealsResponse = await hubspotApi.get('/crm/v3/objects/deals', {
    params: {
      associations: 'companies,contacts',
      limit: 100,
      properties: 'dealname,dealstage,pipeline,amount,closedate,hs_lastmodifieddate'
    }
  });

  const deals = dealsResponse.data.results;
  console.log(`Found ${deals.length} deals. Processing in batches to avoid rate limits...`);
  const stages = await getPipelineStages();

  // Process deals in batches to avoid overwhelming the API
  const dealsWithDetails = await processBatch(deals, async (deal) => {
    let companyName = 'N/A';
    let lastMeetingDate = null;
    let companyId = null;
    let primaryContact = 'N/A';
    let daysInStage = null;

    // Get company info with caching
    if (deal.associations && deal.associations.companies) {
      const companyAssociations = deal.associations.companies.results;

      if (companyAssociations.length > 0) {
        companyId = companyAssociations[0].id;

        try {
          // Use cache for company data
          let companyData = await db.getCompanyCache(companyId, CACHE_ITEM_DURATION);
          if (!companyData) {
            const companyResponse = await hubspotApi.get(`/crm/v3/objects/companies/${companyId}`, {
              params: { properties: 'name' }
            });
            companyData = companyResponse.data.properties;
            await db.setCompanyCache(companyId, companyData);
          }
          companyName = companyData.name || 'N/A';

          lastMeetingDate = await getLastMeetingDate(companyId);
        } catch (error) {
          console.error(`Error fetching company ${companyId}:`, error.response?.data || error.message);
        }
      }
    }

    // Get primary contact with caching
    if (deal.associations && deal.associations.contacts) {
      const contactAssociations = deal.associations.contacts.results;

      if (contactAssociations.length > 0) {
        const contactId = contactAssociations[0].id;

        try {
          // Use cache for contact data
          let contact = await db.getContactCache(contactId, CACHE_ITEM_DURATION);
          if (!contact) {
            const contactResponse = await hubspotApi.get(`/crm/v3/objects/contacts/${contactId}`, {
              params: { properties: 'firstname,lastname,email' }
            });
            contact = contactResponse.data.properties;
            await db.setContactCache(contactId, contact);
          }

          if (contact.firstname || contact.lastname) {
            primaryContact = `${contact.firstname || ''} ${contact.lastname || ''}`.trim();
          } else if (contact.email) {
            primaryContact = contact.email;
          }
        } catch (error) {
          console.error(`Error fetching contact ${contactId}:`, error.response?.data || error.message);
        }
      }
    }

    const stageId = deal.properties.dealstage;
    const stageInfo = stages.stagesMap[stageId];

    // Calculate days in current stage by fetching deal history
    try {
      const dealWithPropertiesResponse = await hubspotApi.get(`/crm/v3/objects/deals/${deal.id}`, {
        params: {
          propertiesWithHistory: 'dealstage'
        }
      });

      const stageHistory = dealWithPropertiesResponse.data.propertiesWithHistory?.dealstage;
      if (stageHistory && stageHistory.length > 0) {
        // Sort by timestamp descending to get the most recent changes first
        const sortedHistory = [...stageHistory].sort((a, b) =>
          new Date(b.timestamp) - new Date(a.timestamp)
        );

        // Find the most recent entry for the current stage
        const currentStageEntry = sortedHistory.find(entry => entry.value === stageId);

        if (currentStageEntry && currentStageEntry.timestamp) {
          const enteredDate = new Date(currentStageEntry.timestamp);
          const now = new Date();
          const diffMs = now - enteredDate;
          daysInStage = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        }
      }
    } catch (error) {
      console.error(`Error fetching stage history for deal ${deal.id}:`, error.response?.data || error.message);
    }

    return {
      id: deal.id,
      dealName: deal.properties.dealname || 'Untitled Deal',
      companyName: companyName,
      companyId: companyId,
      dealStage: stageId,
      dealStageLabel: stageInfo ? stageInfo.label : (stageId || 'N/A'),
      lastMeetingDate: lastMeetingDate,
      primaryContact: primaryContact,
      primaryContactId: deal.associations?.contacts?.results[0]?.id || null,
      daysInStage: daysInStage
    };
  });

  console.log(`Successfully processed ${dealsWithDetails.length} deals.`);
  return dealsWithDetails;
}

// Background refresh function that runs slowly to avoid rate limits
async function refreshDealsInBackground() {
  if (isRefreshing) {
    console.log('Background refresh already in progress, skipping...');
    return;
  }

  isRefreshing = true;
  console.log('Starting background refresh...');

  try {
    const freshData = await fetchAllDeals();
    await db.setDealsCache(freshData);
    console.log('Background refresh completed successfully');
  } catch (error) {
    console.error('Background refresh failed:', error.message);
  } finally {
    isRefreshing = false;
  }
}

// Endpoint to get all deals with caching
app.get('/api/deals', async (req, res) => {
  try {
    const now = Date.now();
    const dealsCache = await db.getDealsCache();
    const cacheAge = dealsCache && dealsCache.lastFetched ? now - dealsCache.lastFetched : Infinity;

    // If cache is fresh, return it immediately
    if (dealsCache && dealsCache.data && cacheAge < CACHE_DURATION) {
      console.log(`Returning cached data (age: ${Math.round(cacheAge / 1000)}s)`);
      return res.json(dealsCache.data);
    }

    // If cache is stale but exists, return it and refresh in background
    if (dealsCache && dealsCache.data && cacheAge >= CACHE_DURATION) {
      console.log('Cache is stale, returning cached data and refreshing in background');
      res.json(dealsCache.data);

      // Trigger background refresh (don't await)
      refreshDealsInBackground();
      return;
    }

    // No cache exists, fetch fresh data
    console.log('No cache exists, fetching fresh data...');
    const freshData = await fetchAllDeals();
    await db.setDealsCache(freshData);
    res.json(freshData);

  } catch (error) {
    console.error('Error fetching deals:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch deals from HubSpot',
      details: error.response?.data || error.message
    });
  }
});

// Endpoint to get cache statistics
app.get('/api/cache/stats', async (req, res) => {
  try {
    const stats = await db.getCacheStats();
    stats.deals.isRefreshing = isRefreshing;
    res.json(stats);
  } catch (error) {
    console.error('Error fetching cache stats:', error.message);
    res.status(500).json({ error: 'Failed to fetch cache statistics' });
  }
});

// Endpoint to clear all caches
app.post('/api/cache/clear', async (req, res) => {
  try {
    await db.clearAllCaches();
    console.log('All caches cleared');
    res.json({ success: true, message: 'All caches cleared' });
  } catch (error) {
    console.error('Error clearing caches:', error.message);
    res.status(500).json({ error: 'Failed to clear caches' });
  }
});

app.patch('/api/deals/:dealId/stage', async (req, res) => {
  try {
    const { dealId } = req.params;
    const { stageId } = req.body;

    if (!stageId) {
      return res.status(400).json({ error: 'stageId is required' });
    }

    const response = await hubspotApi.patch(`/crm/v3/objects/deals/${dealId}`, {
      properties: {
        dealstage: stageId
      }
    });

    // Invalidate cache to trigger refresh on next request
    console.log('Deal stage updated, invalidating cache...');
    await db.clearDealsCache();

    res.json({ success: true, deal: response.data });

  } catch (error) {
    console.error('Error updating deal stage:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to update deal stage in HubSpot',
      details: error.response?.data || error.message
    });
  }
});

// Get all next steps
app.get('/api/next-steps', async (req, res) => {
  try {
    const allNextSteps = await db.getAllNextSteps();
    res.json(allNextSteps);
  } catch (error) {
    console.error('Error fetching next steps:', error.message);
    res.status(500).json({ error: 'Failed to fetch next steps' });
  }
});

// Generate next step for a specific deal
app.post('/api/next-steps/generate/:dealId', async (req, res) => {
  try {
    const { dealId } = req.params;
    const { deal, contactId } = req.body;

    if (!deal) {
      return res.status(400).json({ error: 'deal object is required' });
    }

    console.log(`Generating next step for deal ${dealId}...`);
    const nextStep = await nextSteps.generateNextStepForDeal(deal, contactId, true);

    res.json({ success: true, nextStep });
  } catch (error) {
    console.error('Error generating next step:', error.message);
    res.status(500).json({ error: 'Failed to generate next step', details: error.message });
  }
});

// Generate next steps for all deals (bulk operation)
app.post('/api/next-steps/generate-all', async (req, res) => {
  try {
    const { deals } = req.body;

    if (!deals || !Array.isArray(deals)) {
      return res.status(400).json({ error: 'deals array is required' });
    }

    console.log(`Starting bulk generation of next steps for ${deals.length} deals...`);

    // Process deals one at a time to avoid rate limits
    const results = [];
    for (const deal of deals) {
      try {
        const nextStep = await nextSteps.generateNextStepForDeal(deal, deal.primaryContactId, false);
        results.push({ dealId: deal.id, success: true, nextStep });
      } catch (error) {
        console.error(`Error generating next step for deal ${deal.id}:`, error.message);
        results.push({ dealId: deal.id, success: false, error: error.message });
      }

      // Small delay to avoid overwhelming APIs
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`Completed bulk generation. ${results.filter(r => r.success).length}/${deals.length} successful`);
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error in bulk generation:', error.message);
    res.status(500).json({ error: 'Failed to generate next steps', details: error.message });
  }
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database schema
    await db.initializeDatabase();
    console.log('Database initialized successfully');

    // Start Express server
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      console.log('Open your browser and navigate to the URL above to view your HubSpot deals');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
