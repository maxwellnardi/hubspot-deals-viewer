const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const db = require('./db');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Create HubSpot API client
const hubspotApi = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`
  }
});

/**
 * Fetch engagements (emails and notes) for a company from HubSpot
 */
async function fetchCompanyEngagements(companyId) {
  try {
    // Fetch engagements associated with this company
    const response = await hubspotApi.get(`/engagements/v1/engagements/associated/COMPANY/${companyId}/paged`, {
      params: { limit: 100 }
    });

    const engagements = response.data.results || [];
    const processed = [];

    for (const item of engagements) {
      const { engagement, metadata } = item;

      // Filter for emails and notes only
      if (engagement.type === 'EMAIL' || engagement.type === 'INCOMING_EMAIL' || engagement.type === 'NOTE') {
        // Extract content based on type
        let content = null;
        if (engagement.type === 'NOTE') {
          content = metadata.body || metadata.text;
        } else if (engagement.type === 'EMAIL') {
          // Outgoing emails have full HTML content
          content = metadata.html || metadata.text;
          // Strip HTML tags for cleaner AI analysis
          if (content) {
            content = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          }
        } else if (engagement.type === 'INCOMING_EMAIL') {
          // Incoming emails only have subject
          content = `[Received email with subject: ${metadata.subject || 'No subject'}]`;
        }

        const processed_engagement = {
          id: engagement.id.toString(),
          type: engagement.type,
          timestamp: engagement.timestamp || engagement.createdAt,
          direction: engagement.type === 'INCOMING_EMAIL' ? 'inbound' :
                     engagement.type === 'EMAIL' ? 'outbound' : null,
          content: content,
          metadata: {
            subject: metadata.subject,
            from: metadata.from,
            to: metadata.to,
            cc: metadata.cc
          }
        };
        processed.push(processed_engagement);
      }
    }

    // Sort by timestamp descending and take top 6 (3 emails + 3 notes max)
    processed.sort((a, b) => b.timestamp - a.timestamp);

    const emails = processed.filter(e => e.type.includes('EMAIL')).slice(0, 3);
    const notes = processed.filter(e => e.type === 'NOTE').slice(0, 3);

    // Return with notes first (prioritized), then emails
    return [...notes, ...emails];
  } catch (error) {
    console.error(`Error fetching engagements for company ${companyId}:`, error.message);
    return [];
  }
}

/**
 * Fetch engagements from contact as backup
 */
async function fetchContactEngagements(contactId) {
  try {
    const response = await hubspotApi.get(`/engagements/v1/engagements/associated/CONTACT/${contactId}/paged`, {
      params: { limit: 100 }
    });

    const engagements = response.data.results || [];
    const processed = [];

    for (const item of engagements) {
      const { engagement, metadata } = item;

      if (engagement.type === 'EMAIL' || engagement.type === 'INCOMING_EMAIL' || engagement.type === 'NOTE') {
        const processed_engagement = {
          id: engagement.id.toString(),
          type: engagement.type,
          timestamp: engagement.timestamp || engagement.createdAt,
          direction: engagement.type === 'INCOMING_EMAIL' ? 'inbound' :
                     engagement.type === 'EMAIL' ? 'outbound' : null,
          content: metadata.body || metadata.text || null,
          metadata: {
            subject: metadata.subject,
            from: metadata.from,
            to: metadata.to
          }
        };
        processed.push(processed_engagement);
      }
    }

    processed.sort((a, b) => b.timestamp - a.timestamp);
    const emails = processed.filter(e => e.type.includes('EMAIL')).slice(0, 3);
    const notes = processed.filter(e => e.type === 'NOTE').slice(0, 3);

    // Return with notes first (prioritized), then emails
    return [...notes, ...emails];
  } catch (error) {
    console.error(`Error fetching engagements for contact ${contactId}:`, error.message);
    return [];
  }
}

/**
 * Use Claude AI to analyze engagements and determine next step
 */
async function generateNextStep(engagements, dealName, companyName) {
  if (!engagements || engagements.length === 0) {
    return "No recent activity. Reach out to re-engage";
  }

  // Format engagements for Claude
  const formattedEngagements = engagements.map((eng, idx) => {
    const date = new Date(eng.timestamp);
    const daysAgo = Math.floor((Date.now() - eng.timestamp) / (1000 * 60 * 60 * 24));

    let formatted = `${idx + 1}. [${eng.type}${eng.direction ? ` - ${eng.direction}` : ''}] ${daysAgo} days ago (${date.toLocaleDateString()})`;

    if (eng.metadata?.subject) {
      formatted += `\n   Subject: ${eng.metadata.subject}`;
    }

    if (eng.content) {
      // Truncate long content
      const truncated = eng.content.length > 500 ? eng.content.substring(0, 500) + '...' : eng.content;
      formatted += `\n   Content: ${truncated}`;
    }

    return formatted;
  }).join('\n\n');

  // Check for ghosting scenario
  const lastEngagement = engagements[0];
  const daysSinceLastActivity = Math.floor((Date.now() - lastEngagement.timestamp) / (1000 * 60 * 60 * 24));
  const lastWasOutbound = lastEngagement.direction === 'outbound';

  const prompt = `Deal: ${companyName} - "${dealName}"

NOTES contain AI-generated meeting recaps with detailed next steps, action items, and commitments. Your job is to READ the note content and EXTRACT the single highest-priority action that will push this deal forward.

Activity data:
${formattedEngagements}

${lastWasOutbound && daysSinceLastActivity >= 7 ? '\n⚠️ GHOSTED: Sent message ' + daysSinceLastActivity + 'd ago, no response.\n' : ''}

CRITICAL INSTRUCTIONS:
1. READ the actual content of notes - they contain specific next steps and action items
2. EXTRACT the most important/urgent action item FROM the note
3. DO NOT say "review note" or "check note" - that's useless
4. Surface the ACTUAL action item mentioned in the note
5. If multiple action items in note, pick the one that most directly advances the deal
6. Include specifics: who, what, when, how much

BAD (useless): "Review 1/17 note for next steps"
BAD (useless): "Follow up on meeting action items"
GOOD: "Send pricing for 100-seat license by EOW (per CTO request)"
GOOD: "Schedule tech demo with eng team before Jan 31 deadline"
GOOD: "Get legal approval on data privacy terms (blocking signature)"

OUTPUT: 80 chars max, terse, actionable, specific.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
      temperature: 0.3, // Lower temperature for more focused, consistent output
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const nextStep = message.content[0].text.trim();
    return nextStep;
  } catch (error) {
    console.error('Error calling Claude AI:', error.message, error.response?.data || error);
    return "Error generating next step";
  }
}

/**
 * Generate next step for a deal
 */
async function generateNextStepForDeal(deal, contactId = null, forceRefresh = false) {
  const companyId = deal.companyId;
  const dealId = deal.id;

  // If no company or contact, we can't generate next steps
  if (!companyId && !contactId) {
    console.log(`No company or contact ID for deal ${dealId}`);
    return "No company or contact associated";
  }

  // Use companyId as the storage key, or contactId as fallback
  const storageId = companyId || contactId;

  // Check if we need to refresh
  if (!forceRefresh) {
    const existingNextStep = await db.getNextStep(dealId);
    if (existingNextStep) {
      const cachedEngagementTimestamp = existingNextStep.last_engagement_timestamp;
      const latestEngagementTimestamp = await db.getLastEngagementTimestamp(storageId);

      // If no new engagements, return cached next step
      if (cachedEngagementTimestamp && latestEngagementTimestamp &&
          latestEngagementTimestamp <= cachedEngagementTimestamp) {
        return existingNextStep.next_step;
      }
    }
  }

  // Fetch fresh engagements - try company first, then contact
  let engagements = [];
  if (companyId) {
    engagements = await fetchCompanyEngagements(companyId);
  }

  // Fallback to contact engagements if company has none or no company exists
  if (engagements.length === 0 && contactId) {
    console.log(`${companyId ? 'No company engagements' : 'No company'}, trying contact ${contactId}`);
    engagements = await fetchContactEngagements(contactId);
  }

  // Store engagements in database using the storage ID
  for (const engagement of engagements) {
    await db.saveEngagement(storageId, engagement);
  }

  // Generate next step with AI
  const nextStep = await generateNextStep(engagements, deal.dealName, deal.companyName || 'Unknown Company');

  // Save next step to database
  const lastEngagementTimestamp = engagements.length > 0 ? engagements[0].timestamp : null;
  await db.saveNextStep(dealId, storageId, nextStep, lastEngagementTimestamp);

  return nextStep;
}

module.exports = {
  generateNextStepForDeal,
  fetchCompanyEngagements,
  generateNextStep
};
