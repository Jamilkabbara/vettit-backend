# Vettit Backend — Complete Setup & Deployment Guide

> Written for Jamil — no prior coding knowledge needed. Follow every step exactly.

---

## What This Backend Does

This is the engine behind Vettit.ai. It handles:
- **AI survey generation** using Claude (Anthropic)
- **Real-time pricing** calculated server-side (you never lose margin)
- **Stripe payments** — collects payment before launching surveys
- **Pollfish integration** — sends surveys to real respondents
- **AI results analysis** — generates insights, summaries, follow-up suggestions
- **PDF export** — downloadable research reports
- **Email notifications** — welcome, launch confirmation, completion, invoices
- **File uploads** — images for A/B testing stored in Supabase

---

## Step 1 — Get Your API Keys

Before anything else, collect these. You'll need them all.

### 1a. Supabase (you already have this)
1. Go to supabase.com → your project
2. Click **Settings** → **API**
3. Copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role** key (under "Project API keys") → this is your `SUPABASE_SERVICE_KEY`
   - Never use the anon key for backend — always service_role

### 1b. Anthropic / Claude AI
1. Go to console.anthropic.com
2. Create an account if you don't have one
3. Click **API Keys** → **Create Key**
4. Copy the key → this is your `ANTHROPIC_API_KEY`
5. Add billing (pay-as-you-go, roughly $0.003 per survey generated)

### 1c. Stripe
1. Go to dashboard.stripe.com
2. Create account (use your UAE business details + Wio bank)
3. Click **Developers** → **API Keys**
4. Copy **Secret key** (starts with `sk_live_`) → this is your `STRIPE_SECRET_KEY`
5. For the webhook secret — set this up in Step 4

### 1d. Resend (email)
1. Go to resend.com → create account
2. Click **API Keys** → **Create API Key**
3. Copy the key → this is your `RESEND_API_KEY`
4. Add and verify your domain `vettit.ai` under **Domains**

### 1e. Pollfish (do this when ready)
1. Go to pollfish.com → create account
2. Email support@pollfish.com and say:
   "I'm building a white-label market research platform and need researcher API
   access to programmatically create and launch surveys via your API."
3. They'll send you API credentials — add them to .env when ready
4. Until then, the backend runs in **mock mode** — everything works, surveys are simulated

---

## Step 2 — Run the Database Migration

1. Go to supabase.com → your project
2. Click **SQL Editor** in the left menu
3. Click **New query**
4. Open the file `src/db/migration.sql` from this project
5. Copy all its contents, paste into the SQL editor
6. Click **Run**
7. You'll see a column list at the bottom — that means it worked

### Create the Storage Bucket
1. In Supabase, click **Storage** in the left menu
2. Click **New bucket**
3. Name it exactly: `vettit-uploads`
4. Toggle **Public bucket** to ON
5. Click **Save**

---

## Step 3 — Deploy to Railway

### 3a. Push backend to GitHub
1. Go to github.com → your account
2. Click **New repository** → name it `vettit-backend` → **Private**
3. Click **Create repository**
4. Follow the "push existing repository" instructions shown

Or tell Claude Code:
"Push the vettit-backend folder to github.com/Jamilkabbara/vettit-backend"

### 3b. Create Railway project
1. Go to railway.app → sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Choose `vettit-backend`
4. Railway detects Node.js automatically

### 3c. Add environment variables on Railway
1. Click your service → **Variables** tab → **Raw Editor**
2. Paste and fill in your real values:

```
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://www.vettit.ai
SUPABASE_URL=your_value_here
SUPABASE_SERVICE_KEY=your_value_here
ANTHROPIC_API_KEY=your_value_here
STRIPE_SECRET_KEY=your_value_here
STRIPE_WEBHOOK_SECRET=your_value_here
RESEND_API_KEY=your_value_here
FROM_EMAIL=hello@vettit.ai
FROM_NAME=Vettit
POLLFISH_API_KEY=your_value_here
POLLFISH_SECRET_KEY=your_value_here
STORAGE_BUCKET=vettit-uploads
VETTIT_MARGIN=0.30
```

3. Click **Save** — Railway redeploys automatically

### 3d. Get your backend URL
1. Click your service → **Settings** → **Networking** → **Generate Domain**
2. You'll get something like: `https://vettit-backend-production.up.railway.app`
3. Save this URL — you need it for Step 4 and Step 5

---

## Step 4 — Set Up Stripe Webhook

1. Go to dashboard.stripe.com → **Developers** → **Webhooks**
2. Click **Add endpoint**
3. Endpoint URL: `https://YOUR-RAILWAY-URL/api/webhooks/stripe`
4. Select these events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
5. Click **Add endpoint**
6. Click the endpoint → **Reveal** the Signing secret
7. Copy it → Railway → add as `STRIPE_WEBHOOK_SECRET`

---

## Step 5 — Connect Frontend to Backend

In your Vercel dashboard (where vettit.ai frontend is deployed):
1. Go to your Vettit project → **Settings** → **Environment Variables**
2. Add: `VITE_API_URL` = your Railway URL

Then in Claude Code:
"Update all frontend API calls to use the VITE_API_URL environment variable"

---

## Step 6 — Test It's Working

Open your browser and visit:
`https://YOUR-RAILWAY-URL/health`

You should see: `{"status":"ok","timestamp":"...","version":"1.0.0"}`

If you see that — your backend is live and working.

---

## API Reference (All Endpoints)

All endpoints require `Authorization: Bearer YOUR_SUPABASE_JWT` except `/health` and `/api/auth/register`.

### AI Endpoints
| Endpoint | What it does |
|----------|-------------|
| POST /api/ai/generate-survey | Generate full survey from description |
| POST /api/ai/refine-question | Improve a single question |
| POST /api/ai/refine-description | Clean up mission description |
| POST /api/ai/suggest-targeting | Get AI targeting recommendations |
| POST /api/ai/analyse-results | Generate full AI insights report |

### Mission Endpoints
| Endpoint | What it does |
|----------|-------------|
| GET /api/missions | List all user missions |
| GET /api/missions/:id | Get single mission |
| POST /api/missions | Create mission (draft) |
| PATCH /api/missions/:id | Auto-save mission changes |
| DELETE /api/missions/:id | Archive mission |
| POST /api/missions/pricing/calculate | Calculate real-time price |

### Payment Endpoints
| Endpoint | What it does |
|----------|-------------|
| POST /api/payments/create-intent | Create Stripe payment intent |
| POST /api/payments/confirm | Confirm payment and launch survey |

### Results Endpoints
| Endpoint | What it does |
|----------|-------------|
| GET /api/results/:missionId | Get results and AI insights |
| GET /api/results/:missionId/status | Poll mission progress |
| GET /api/results/:missionId/export/pdf | Download PDF report |
| GET /api/results/:missionId/export/raw | Download raw JSON |

### Profile Endpoints
| Endpoint | What it does |
|----------|-------------|
| GET /api/profile | Get profile |
| PATCH /api/profile | Update profile |
| GET /api/profile/invoices | Get all invoices |
| PATCH /api/profile/password | Change password |

---

## How Pricing Works (You Never Lose Money)

The backend always recalculates price before processing payment.
The frontend shows estimates — the backend is the final source of truth.

Your rates:
- Tier 1 (US, UK, CA, AU): $3.50 per respondent
- Tier 2 (UAE, SA, DE, FR): $2.75 per respondent
- Tier 3 (Rest of World): $1.90 per respondent

Plus surcharges for extra questions, professional targeting, screening, and retargeting.

Once you have Pollfish pricing confirmed, update the rates in:
`src/utils/pricingEngine.js` — the CUSTOMER_RATES object at the top.

---

## Troubleshooting

**"Cannot connect to Supabase"**
Check SUPABASE_URL and SUPABASE_SERVICE_KEY in Railway variables.

**"Claude AI not responding"**
Check ANTHROPIC_API_KEY and billing at console.anthropic.com.

**"Stripe payment failing"**
Make sure you're using the live key (sk_live_) not test key in production.

**"Emails not sending"**
Verify your domain in Resend dashboard and check RESEND_API_KEY.

**Backend crashed"**
Go to Railway → your service → Logs tab to see the error message.
Paste the error into Claude chat and it'll be fixed immediately.

---

## Using Claude Code

Once Claude Code is working, paste this single instruction:

"Clone https://github.com/Jamilkabbara/vettit-backend, run npm install,
create a .env file from .env.example with the values I provide, run the
migration.sql in Supabase, deploy to Railway, and confirm the /health
endpoint responds with status ok."

---

**Vettit Backend v1.0.0** — Built for Jamil Kabbara — vettit.ai
