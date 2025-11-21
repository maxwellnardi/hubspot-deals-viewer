# Google Calendar API Setup Guide

This guide will help you set up Google Calendar API access to sync calendar events from max@runlayer.com, tal@runlayer.com, and andy@runlayer.com into HubSpot.

## Step 1: Create OAuth 2.0 Credentials

### A. Go to Google Cloud Console
1. Visit [Google Cloud Console](https://console.cloud.google.com/)
2. Sign in with your Google account

### B. Create or Select a Project
1. Click the project dropdown (top-left, next to "Google Cloud")
2. Click **"New Project"**
3. Name it: `HubSpot Calendar Sync`
4. Click **"Create"** and wait for it to finish
5. Select your new project from the dropdown

### C. Enable Google Calendar API
1. In the left sidebar, click **"APIs & Services"** → **"Library"**
2. Search for: `Google Calendar API`
3. Click on "Google Calendar API"
4. Click **"Enable"**

### D. Configure OAuth Consent Screen
1. Go to **"APIs & Services"** → **"OAuth consent screen"**
2. Select **"External"** user type
3. Click **"Create"**
4. Fill in the required fields:
   - **App name**: `HubSpot Calendar Sync`
   - **User support email**: Your email
   - **Developer contact email**: Your email
5. Click **"Save and Continue"**

6. On the **"Scopes"** page:
   - Click **"Add or Remove Scopes"**
   - Search for and add these scopes:
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/calendar.events.readonly`
   - Click **"Update"**
   - Click **"Save and Continue"**

7. On the **"Test users"** page:
   - Click **"+ Add Users"**
   - Add these emails:
     - `max@runlayer.com`
     - `tal@runlayer.com`
     - `andy@runlayer.com`
   - Click **"Add"**
   - Click **"Save and Continue"**

### E. Create OAuth 2.0 Client ID
1. Go to **"APIs & Services"** → **"Credentials"**
2. Click **"+ Create Credentials"** → **"OAuth client ID"**
3. Choose **Application type**: "Desktop app"
4. Name: `Calendar Sync Desktop Client`
5. Click **"Create"**

6. A dialog appears with your credentials:
   - **Client ID**: Copy this
   - **Client Secret**: Copy this
7. Click **"OK"**

## Step 2: Add Credentials to .env File

Open your `.env` file and add the credentials you just copied:

```bash
GOOGLE_CLIENT_ID=123456789-abcdefghijklmnop.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your_client_secret_here
GOOGLE_REFRESH_TOKEN=
```

**Note:** Leave `GOOGLE_REFRESH_TOKEN` empty for now - we'll get it in the next step.

## Step 3: Get Refresh Tokens

You need to get a refresh token for EACH of the 3 calendar accounts (max@, tal@, andy@).

### For the FIRST account (max@runlayer.com):

1. Run the token helper script:
   ```bash
   node get-google-token.js
   ```

2. The script will print a URL. Copy and paste it into your browser.

3. **Sign in with max@runlayer.com**

4. Google will show a warning: "Google hasn't verified this app"
   - Click **"Advanced"**
   - Click **"Go to HubSpot Calendar Sync (unsafe)"**
   - This is safe - it's your own app!

5. Click **"Allow"** to grant calendar access permissions

6. Google will show an authorization code. Copy it.

7. Paste the code back into the terminal and press Enter

8. The script will print your tokens:
   ```
   GOOGLE_REFRESH_TOKEN=1//abc123def456...
   GOOGLE_ACCESS_TOKEN=ya29.xyz789...
   ```

9. Copy the **GOOGLE_REFRESH_TOKEN** value and add it to your `.env` file:
   ```bash
   GOOGLE_REFRESH_TOKEN=1//abc123def456...
   ```

### For the OTHER accounts (tal@ and andy@):

Since we need to access multiple calendars, you have two options:

**Option A: Domain-wide Delegation (Recommended for Google Workspace)**
- If your organization uses Google Workspace, you can set up domain-wide delegation
- This allows one service account to access all calendars
- See: https://developers.google.com/workspace/guides/create-credentials#service-account

**Option B: Multiple OAuth Flows (Current approach)**
- Repeat Step 3 above for tal@runlayer.com and andy@runlayer.com
- You'll need to store multiple refresh tokens
- We'll need to modify the code to handle multiple tokens

For now, we'll use the token from max@runlayer.com and you can add the others later.

## Step 4: Test the Integration

1. Make sure your `.env` file has all three credentials:
   ```bash
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REFRESH_TOKEN=...
   ```

2. Restart your server:
   ```bash
   npm start
   ```

3. Open http://localhost:3000

4. Click the 📅 calendar icon next to any company's "Last Meeting" field

5. The modal should show calendar sync in progress!

## Troubleshooting

### "No refresh token received"
This happens if you already authorized the app before. To fix:
1. Go to https://myaccount.google.com/permissions
2. Find "HubSpot Calendar Sync" and click "Remove access"
3. Run `node get-google-token.js` again

### "Access blocked: This app's request is invalid"
Make sure you added the email addresses as test users in the OAuth consent screen.

### "The user has not granted the app... scopes"
You need to revoke access and re-authorize with the calendar.readonly scope.

## Next Steps

Once you have the basic integration working with one calendar (max@), I can help you:
1. Set up domain-wide delegation for all 3 calendars
2. Implement the actual calendar fetching and HubSpot sync logic
3. Add duplicate detection and contact creation
4. Deploy to Render with the new environment variables

Let me know when you're ready!
