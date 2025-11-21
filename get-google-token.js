/**
 * Script to get Google OAuth refresh token for Calendar API access
 *
 * BEFORE RUNNING:
 * 1. Create OAuth 2.0 credentials in Google Cloud Console
 * 2. Download the credentials JSON file
 * 3. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env file
 *
 * HOW TO RUN:
 * node get-google-token.js
 *
 * This will:
 * 1. Print an authorization URL
 * 2. You visit the URL and authorize access for each email (max@, tal@, andy@)
 * 3. You paste the authorization code back
 * 4. The script prints the refresh token to add to .env
 */

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3001/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ ERROR: Missing Google credentials!');
  console.error('\nPlease add these to your .env file:');
  console.error('GOOGLE_CLIENT_ID=your_client_id_here');
  console.error('GOOGLE_CLIENT_SECRET=your_client_secret_here\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Scopes for Google Calendar readonly access
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly'
];

async function getToken() {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent' // Force to get refresh token
    });

    console.log('\n📋 INSTRUCTIONS:');
    console.log('================\n');
    console.log('1. Copy the URL below and open it in your browser');
    console.log('2. Sign in with one of these accounts:');
    console.log('   - max@runlayer.com');
    console.log('   - tal@runlayer.com');
    console.log('   - andy@runlayer.com\n');
    console.log('3. Grant calendar access permissions');
    console.log('4. You\'ll be redirected back automatically\n');

    const server = http.createServer(async (req, res) => {
      try {
        if (req.url.indexOf('/oauth2callback') > -1) {
          const qs = new url.URL(req.url, 'http://localhost:3001').searchParams;
          const code = qs.get('code');

          res.end('✅ Authorization successful! You can close this window and return to the terminal.');
          server.close();

          const { tokens } = await oauth2Client.getToken(code);

          console.log('\n✅ SUCCESS! Here are your tokens:\n');
          console.log('================================\n');
          console.log('Add these to your .env file:\n');
          console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
          console.log(`GOOGLE_ACCESS_TOKEN=${tokens.access_token}\n`);
          console.log('================================\n');
          console.log('⚠️  IMPORTANT: Save the GOOGLE_REFRESH_TOKEN to your .env file');
          console.log('   The access token expires, but the refresh token is permanent\n');

          if (!tokens.refresh_token) {
            console.log('⚠️  WARNING: No refresh token received!');
            console.log('   This might happen if you already authorized this app.');
            console.log('   To fix: Revoke app access at https://myaccount.google.com/permissions');
            console.log('   Then run this script again.\n');
          }

          resolve(tokens);
        }
      } catch (error) {
        console.error('\n❌ ERROR getting tokens:', error.message);
        reject(error);
      }
    }).listen(3001, () => {
      console.log('🔗 AUTHORIZATION URL:');
      console.log('===================\n');
      console.log(authUrl + '\n');
      console.log('===================\n');
      console.log('⏳ Waiting for authorization...\n');
    });
  });
}

getToken().catch(console.error);
