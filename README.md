# Review Appeal SaaS — Setup Guide

## Stack
- **Backend**: Node.js + Express, deployed on Render
- **Frontend**: React + Vite (build separately)
- **Database**: PostgreSQL (Render free tier)
- **Auth**: Google OAuth 2.0
- **AI**: Claude API (Anthropic)

---

## Step 1 — Google Cloud Console

1. Go to https://console.cloud.google.com
2. Create a new project: "Review Appeal"
3. Enable these APIs:
   - Google My Business API
   - My Business Account Management API
   - My Business Business Information API
   - OAuth 2.0 / People API
4. Go to "Credentials" → "Create OAuth 2.0 Client ID"
   - Type: Web application
   - Authorized redirect URIs: `https://your-app.onrender.com/auth/callback`
5. Copy Client ID and Client Secret → paste into Render env vars

---

## Step 2 — Deploy to Render

1. Push this repo to GitHub
2. Go to https://render.com → "New" → "Blueprint"
3. Connect your GitHub repo — Render reads `render.yaml` automatically
4. It will create:
   - Web service (Node.js server)
   - PostgreSQL database
5. Fill in env vars (Google Client ID/Secret, Anthropic API Key, Client URL)
6. Deploy!

---

## Step 3 — Anthropic API Key

1. Go to https://console.anthropic.com
2. Create API Key
3. Add to Render env vars as `ANTHROPIC_API_KEY`

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /auth/google | Start OAuth flow |
| GET | /auth/callback | OAuth callback |
| GET | /auth/me | Get current user |
| POST | /auth/logout | Logout |
| GET | /api/locations | Get user's business locations |
| GET | /api/reviews?locationName=&threshold= | Fetch reviews |
| POST | /api/analyze | Analyze review with Claude |
| POST | /api/appeal | Submit appeal to Google |
| GET | /api/appeals/history | Appeal history |

---

## Local Development

```bash
cd server
cp .env.example .env
# Fill in .env values
npm install
npm run dev
```

Note: For local OAuth to work, add `http://localhost:3001/auth/callback`
to your Google OAuth authorized redirect URIs.
