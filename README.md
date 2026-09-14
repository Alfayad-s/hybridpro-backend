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
