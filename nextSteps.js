const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const db = require('./db');
const { google } = require('googleapis');

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

// Google Calendar OAuth2 client
let calendar = null;
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000'
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  calendar = google.calendar({ version: 'v3', auth: oauth2Client });
}

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
 * Fetch upcoming meetings for a company from Google Calendar
 */
async function fetchUpcomingMeetings(companyId, companyDomain) {
  if (!calendar || !companyDomain) {
    return [];
  }

  try {
    const now = new Date();
    const threeMonthsFromNow = new Date();
    threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);

    // Calendars to search
    const calendarIds = [
      'max@runlayer.com',
      'tal@runlayer.com',
      'andy@runlayer.com',
      'andy@anysource.com'
    ];

    const allEvents = [];

    // Fetch from all calendars
    for (const calendarId of calendarIds) {
      try {
        const response = await calendar.events.list({
          calendarId: calendarId,
          timeMin: now.toISOString(),
          timeMax: threeMonthsFromNow.toISOString(),
          maxResults: 100,
          singleEvents: true,
          orderBy: 'startTime'
        });

        const events = response.data.items || [];
        allEvents.push(...events);
      } catch (error) {
        console.error(`Error fetching calendar ${calendarId}:`, error.message);
      }
    }

    // Deduplicate events by ID
    const eventMap = new Map();
    allEvents.forEach(event => {
      if (!eventMap.has(event.id)) {
        eventMap.set(event.id, event);
      }
    });

    const uniqueEvents = Array.from(eventMap.values());

    // Filter for events matching the company domain
    const matchedEvents = uniqueEvents.filter(event => {
      if (!event.attendees || event.attendees.length === 0) {
        return false;
      }

      return event.attendees.some(attendee => {
        const email = attendee.email.toLowerCase();
        return email.endsWith(`@${companyDomain}`);
      });
    });

    // Return only the next 3 upcoming meetings
    return matchedEvents.slice(0, 3);
  } catch (error) {
    console.error(`Error fetching upcoming meetings for company ${companyId}:`, error.message);
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
async function generateNextStep(engagements, dealName, companyName, upcomingMeetings = []) {
  if (!engagements || engagements.length === 0) {
    return "No recent activity. Reach out to re-engage";
  }

  // Get current date for context
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

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

  // Format upcoming meetings if any
  let upcomingMeetingsContext = '';
  if (upcomingMeetings && upcomingMeetings.length > 0) {
    const formattedMeetings = upcomingMeetings.map(m => {
      const meetingDate = new Date(m.start?.dateTime || m.start?.date);
      const daysUntil = Math.ceil((meetingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return `- "${m.summary}" scheduled for ${meetingDate.toLocaleDateString()} (in ${daysUntil} days)`;
    }).join('\n');
    upcomingMeetingsContext = `\n\n📅 UPCOMING MEETINGS ALREADY SCHEDULED:\n${formattedMeetings}\n(Do NOT suggest scheduling these - they're already on calendar)`;
  }

  // Check for ghosting scenario
  const lastEngagement = engagements[0];
  const daysSinceLastActivity = Math.floor((Date.now() - lastEngagement.timestamp) / (1000 * 60 * 60 * 24));
  const lastWasOutbound = lastEngagement.direction === 'outbound';

  const prompt = `TODAY'S DATE: ${currentDate}

Deal: ${companyName} - "${dealName}"

NOTES contain AI-generated meeting recaps with detailed next steps, action items, and commitments. Your job is to READ the note content and EXTRACT the single highest-priority action that will push this deal forward.

Activity data:
${formattedEngagements}
${upcomingMeetingsContext}

${lastWasOutbound && daysSinceLastActivity >= 7 ? '\n⚠️ GHOSTED: Sent message ' + daysSinceLastActivity + 'd ago, no response.\n' : ''}

CRITICAL INSTRUCTIONS:
1. READ the actual content of notes - they contain specific next steps and action items
2. EXTRACT the most important/urgent action item FROM the note
3. DO NOT say "review note" or "check note" - that's useless
4. Surface the ACTUAL action item mentioned in the note
5. If multiple action items in note, pick the one that most directly advances the deal
6. Include specifics: who, what, when, how much
7. NEVER mention company name - it's already shown in the same row
8. Be maximally concise - cut unnecessary words like "team", "to discuss next steps"
9. ⚠️ NEVER suggest actions for dates that have ALREADY PASSED relative to today's date
10. ⚠️ If a follow-up meeting is already scheduled (see UPCOMING MEETINGS), DO NOT suggest "schedule follow-up meeting"
11. If suggested action references a past date or already-scheduled meeting, say "Unsure" instead

BAD (useless): "Review 1/17 note for next steps"
BAD (verbose): "Schedule follow-up meeting with HPE team to discuss next steps"
BAD (redundant): "Follow up with Acme about pricing"
BAD (past date): "Schedule meeting on Nov 11" (when today is Nov 24)
BAD (already scheduled): "Schedule follow-up meeting" (when one is already on calendar)
GOOD: "Send pricing for 100-seat license by EOW (per CTO request)"
GOOD: "Schedule tech demo before Jan 31 deadline"
GOOD: "Get legal approval on data privacy terms (blocking signature)"
GOOD: "Unsure" (if all action items reference past dates or are already completed)

OUTPUT: 80 chars max, terse, actionable, specific. NO company name.`;

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

  // Fetch upcoming meetings from Google Calendar if we have a company domain
  let upcomingMeetings = [];
  if (companyId && deal.companyDomain) {
    upcomingMeetings = await fetchUpcomingMeetings(companyId, deal.companyDomain);
  }

  // Generate next step with AI
  const nextStep = await generateNextStep(engagements, deal.dealName, deal.companyName || 'Unknown Company', upcomingMeetings);

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
