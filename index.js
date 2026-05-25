require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── DB ───────────────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT,
      access_token TEXT,
      refresh_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS appeals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      review_id TEXT NOT NULL,
      review_text TEXT,
      rating INTEGER,
      reason TEXT,
      appeal_text TEXT,
      status TEXT DEFAULT 'pending',
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173", credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ─── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/auth/callback"
  );
}

const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/business.manage"
];

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
}

// ─── ROUTES: AUTH ─────────────────────────────────────────────────────────────

// Step 1 — redirect user to Google consent screen
app.get("/auth/google", (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });
  res.redirect(url);
});

// Step 2 — Google redirects back with ?code=
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`${process.env.CLIENT_URL}/?error=auth_denied`);

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    // Upsert user in DB
    const result = await db.query(
      `INSERT INTO users (google_id, email, name, access_token, refresh_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (google_id) DO UPDATE
       SET email=$2, name=$3, access_token=$4, refresh_token=COALESCE($5, users.refresh_token)
       RETURNING id`,
      [userInfo.id, userInfo.email, userInfo.name, tokens.access_token, tokens.refresh_token]
    );

    req.session.userId = result.rows[0].id;
    res.redirect(`${process.env.CLIENT_URL}/dashboard`);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.redirect(`${process.env.CLIENT_URL}/?error=auth_failed`);
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  const { rows } = await db.query("SELECT id, email, name FROM users WHERE id=$1", [req.session.userId]);
  res.json(rows[0] || null);
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── ROUTES: REVIEWS ──────────────────────────────────────────────────────────

// Get all locations for this user's Google Business account
app.get("/api/locations", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT access_token, refresh_token FROM users WHERE id=$1", [req.session.userId]);
    const user = rows[0];

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ access_token: user.access_token, refresh_token: user.refresh_token });

    // My Business Account Management API
    const mybusiness = google.mybusinessaccountmanagement({ version: "v1", auth: oauth2Client });
    const { data } = await mybusiness.accounts.list();
    const accounts = data.accounts || [];

    const mybusinessInfo = google.mybusinessbusinessinformation({ version: "v1", auth: oauth2Client });
    const locations = [];

    for (const account of accounts) {
      const { data: locData } = await mybusinessInfo.accounts.locations.list({
        parent: account.name,
        readMask: "name,title,storefrontAddress"
      });
      if (locData.locations) locations.push(...locData.locations);
    }

    res.json({ locations });
  } catch (err) {
    console.error("Locations error:", err.message);
    res.status(500).json({ error: "Failed to fetch locations", detail: err.message });
  }
});

// Fetch reviews for a location, filtered by threshold
app.get("/api/reviews", requireAuth, async (req, res) => {
  const { locationName, threshold = 3 } = req.query;
  if (!locationName) return res.status(400).json({ error: "locationName is required" });

  try {
    const { rows } = await db.query("SELECT access_token, refresh_token FROM users WHERE id=$1", [req.session.userId]);
    const user = rows[0];

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ access_token: user.access_token, refresh_token: user.refresh_token });

    const mybusiness = google.mybusinessreviews({ version: "v4", auth: oauth2Client });
    const { data } = await mybusiness.accounts.locations.reviews.list({
      parent: locationName
    });

    const allReviews = data.reviews || [];
    const ratingMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

    const reviews = allReviews.map(r => ({
      reviewId: r.reviewId,
      reviewer: r.reviewer?.displayName || "Anonymous",
      rating: ratingMap[r.starRating] || 0,
      text: r.comment || "(no text)",
      createTime: r.createTime,
      flagged: ratingMap[r.starRating] <= parseInt(threshold)
    }));

    res.json({ reviews, total: reviews.length, flagged: reviews.filter(r => r.flagged).length });
  } catch (err) {
    console.error("Reviews error:", err.message);
    res.status(500).json({ error: "Failed to fetch reviews", detail: err.message });
  }
});

// ─── ROUTES: CLAUDE ANALYSIS ──────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post("/api/analyze", requireAuth, async (req, res) => {
  const { reviewText, rating, reviewId } = req.body;
  if (!reviewText) return res.status(400).json({ error: "reviewText is required" });

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `You are an expert in Google Business review policy and reputation management.
Analyze this Google review and determine the best grounds for an appeal/removal request.

Review (${rating} stars):
"${reviewText}"

Google's valid removal reasons:
- SPAM: Fake, irrelevant, or promotional content
- FAKE: Not a real customer experience / conflict of interest
- IRRELEVANT: Not about the business itself (wrong location, off-topic)
- HARASSMENT: Threatening, offensive, or personal attacks
- PRIVATE_INFO: Contains personal/confidential information

Return ONLY valid JSON, no markdown:
{
  "reason": "SPAM|FAKE|IRRELEVANT|HARASSMENT|PRIVATE_INFO",
  "reason_he": "שם הסיבה בעברית",
  "confidence": "HIGH|MEDIUM|LOW",
  "explanation_he": "הסבר קצר בעברית (1-2 משפטים)",
  "appeal_text": "Professional appeal text in English for Google (2-3 sentences, citing specific policy violation)",
  "policy_reference": "Which Google policy this violates"
}`
      }]
    });

    const text = message.content.find(b => b.type === "text")?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(clean);

    // Save analysis to DB
    await db.query(
      `INSERT INTO appeals (user_id, review_id, review_text, rating, reason, appeal_text, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'analyzed')
       ON CONFLICT DO NOTHING`,
      [req.session.userId, reviewId || "unknown", reviewText, rating, analysis.reason, analysis.appeal_text]
    );

    res.json({ success: true, analysis });
  } catch (err) {
    console.error("Analysis error:", err.message);
    res.status(500).json({ error: "Analysis failed", detail: err.message });
  }
});

// ─── ROUTES: SUBMIT APPEAL ────────────────────────────────────────────────────

app.post("/api/appeal", requireAuth, async (req, res) => {
  const { locationName, reviewId, reason } = req.body;
  if (!locationName || !reviewId || !reason) {
    return res.status(400).json({ error: "locationName, reviewId, and reason are required" });
  }

  try {
    const { rows } = await db.query("SELECT access_token, refresh_token FROM users WHERE id=$1", [req.session.userId]);
    const user = rows[0];

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ access_token: user.access_token, refresh_token: user.refresh_token });

    // Google My Business API — flag/report review
    const mybusiness = google.mybusinessreviews({ version: "v4", auth: oauth2Client });
    await mybusiness.accounts.locations.reviews.deleteReview({
      name: `${locationName}/reviews/${reviewId}`
    });

    // Update DB status
    await db.query(
      "UPDATE appeals SET status='submitted', submitted_at=NOW() WHERE user_id=$1 AND review_id=$2",
      [req.session.userId, reviewId]
    );

    res.json({ success: true, message: "Appeal submitted to Google" });
  } catch (err) {
    console.error("Appeal error:", err.message);
    // Google doesn't always allow direct delete — flag it instead
    res.status(500).json({ error: "Appeal submission failed", detail: err.message });
  }
});

// History of submitted appeals
app.get("/api/appeals/history", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM appeals WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 50",
    [req.session.userId]
  );
  res.json({ appeals: rows });
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error("DB init failed:", err.message, err.stack);
    process.exit(1);
  });
