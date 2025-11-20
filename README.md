# HubSpot Deals Viewer

A web-based application that displays your HubSpot deals in a clean, spreadsheet-like interface.

## Features

- View all your HubSpot deals in one place
- See deal name, company name, deal stage, and last meeting date
- Automatic calculation of the most recent meeting with each company
- Clean, responsive UI with refresh capability
- Secure server-side API handling

## Prerequisites

- Node.js (v14 or higher)
- A HubSpot account with deals
- HubSpot Private App access token

## Getting Your HubSpot Access Token

1. Log in to your HubSpot account
2. Go to Settings > Integrations > Private Apps
3. Click "Create a private app"
4. Give it a name (e.g., "Deals Viewer")
5. Go to the "Scopes" tab and enable these scopes:
   - `crm.objects.deals.read`
   - `crm.objects.companies.read`
   - `crm.objects.contacts.read`
   - `crm.schemas.deals.read`
   - `crm.schemas.companies.read`
6. Click "Create app" and copy the access token

## Installation

1. Navigate to the project directory:
```bash
cd hubspot-deals-viewer
```

2. Install dependencies (already done if you just set this up):
```bash
npm install
```

3. Configure your HubSpot access token:
   - Open the `.env` file
   - Replace `your_hubspot_private_app_access_token_here` with your actual token:
   ```
   HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   PORT=3000
   ```

## Running the App

Start the server:
```bash
npm start
```

Open your browser and go to:
```
http://localhost:3000
```

## Usage

- The app will automatically load all deals from your HubSpot account
- Click the "Refresh" button to reload the data
- The "Last Meeting" column shows the most recent meeting date/time with the associated company

## Troubleshooting

**Error: "Failed to fetch deals from HubSpot"**
- Check that your access token is correct in the `.env` file
- Ensure your Private App has the required scopes
- Verify that you have deals in your HubSpot account

**No meetings showing**
- Meetings are pulled from HubSpot's meetings/activities associated with the company
- Ensure meetings are properly logged in HubSpot and associated with companies

## Project Structure

```
hubspot-deals-viewer/
├── server.js           # Express backend with HubSpot API integration
├── public/
│   └── index.html      # Frontend UI
├── .env                # Environment variables (your access token)
├── .env.example        # Example environment file
├── package.json        # Project dependencies
└── README.md           # This file
```

## API Endpoints

- `GET /api/deals` - Fetches all deals with company info and last meeting dates

## Security Notes

- Never commit your `.env` file to version control
- Keep your HubSpot access token private
- The `.gitignore` file is configured to exclude sensitive files

## License

ISC
