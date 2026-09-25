# Hybrid Pro Backend (NestJS)

Subscription APIs for website checkout, the mobile app, and the coach admin on the Fitness Coaching Platform.

Admin UI is on the website at `/admin`. This service only exposes APIs.

## Run locally

```bash
cp .env.example .env
# fill DATABASE_URL, INTERNAL_API_SECRET, COACH_EMAIL, COACH_PASSWORD
npm install
npm run dev
```

API: [http://localhost:3002/api/health](http://localhost:3002/api/health)

## Point the other apps here

Website and mobile app `.env.local`:

```bash
HYBRID_BACKEND_URL=http://localhost:3002
INTERNAL_API_SECRET=same-as-backend
```

## Deploy on Render (current)

Keep the database on Supabase. Render free sleeps after ~15 minutes idle.

1. Push this repo to GitHub (`Alfayad-s/hybridpro-backend`).
2. In [Render](https://dashboard.render.com): **New → Web Service → Connect the GitHub repo**.
3. Settings:
   - Language: **Node**
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `node dist/main.js`
   - Instance: **Free**
   - Health check path: `/api/health`
4. Add environment variables (do not set `PORT` — Render sets it):

```bash
NODE_ENV=production
DATABASE_URL=your-supabase-url
INTERNAL_API_SECRET=same-as-website-and-app
COACH_EMAIL=akash@hybridpro.fit
COACH_PASSWORD=your-coach-password
COACH_SESSION_SECRET=your-session-secret
WEBSITE_URL=https://hybridpro.in
APP_URL=https://app.hybridpro.in
# Required for email OTP (Resend — use a verified domain)
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM=Hybrid Pro <noreply@hybridpro.in>
GOOGLE_CLIENT_IDS=web-client-id,ios-client-id,android-client-id
```
5. Deploy, then open `https://your-service.onrender.com/api/health`.
6. On Vercel (website + app):

```bash
HYBRID_BACKEND_URL=https://your-service.onrender.com
INTERNAL_API_SECRET=same-as-backend
```

The first request after idle can take 30–50 seconds.

## Deploy on Oracle Cloud Always Free

Use an Ampere A1 ARM VM (Always Free). Keep the database on Supabase. Put the API behind HTTPS at `api.hybridpro.in`.

1. Create a free Oracle Cloud account. Home region cannot be changed later.
2. Create a VCN with a public subnet. Ingress rules: TCP **22**, **80**, **443**.
3. Create a compute instance:
   - Image: Ubuntu 22.04 or 24.04
   - Shape: **VM.Standard.A1.Flex** (Ampere)
   - 1 OCPU, 6 GB RAM is enough
   - Assign a public IP
   - Add your SSH public key
4. If instance create fails with out of capacity, try another availability domain.
5. Point **api.hybridpro.in** A record at the VM public IP.
6. SSH in and install Docker:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER
# log out and back in
```

7. Clone and start:

```bash
git clone git@github.com:Alfayad-s/hybridpro-backend.git
cd hybridpro-backend
cp .env.example .env
nano .env
docker compose up -d --build
```

8. Confirm `https://api.hybridpro.in/api/health` returns `{"ok":true,"supabaseConfigured":true,...}`.
9. On Vercel (website) set:

```bash
HYBRID_BACKEND_URL=https://api.hybridpro.in
INTERNAL_API_SECRET=same-as-backend
PAYMENT_CALLBACK_BASE_URL=https://hybridpro.in
NEXT_PUBLIC_SITE_URL=https://hybridpro.in
NEXT_PUBLIC_APP_URL=https://hybridpro.in
```

`.env` on the VM **must** include:

- `DATABASE_URL` (Supabase Postgres pooler)
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` (same project — required for `/api/me/*` and post-payment unlock)
- `INTERNAL_API_SECRET`, `COACH_EMAIL`, `COACH_PASSWORD`, `COACH_SESSION_SECRET`
- `WEBSITE_URL=https://hybridpro.in`, `APP_URL=https://app.hybridpro.in`, `PORT=3002`

Without `SUPABASE_URL` / `SUPABASE_ANON_KEY`, Pine Labs can still charge, but the member app will show **Supabase is not configured** when unlocking after payment.
