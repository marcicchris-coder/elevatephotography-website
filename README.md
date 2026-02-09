# Photography Website + Aryeo Integration

## Files

- `index.html` - site structure and content
- `portfolio.html` - Aryeo shoots portfolio page (API-driven)
- `order.html` - on-site order page with embedded Aryeo form + live order status
- `styles.css` - styling and responsive layout
- `site-config.js` - central links and API base URL
- `script.js` - frontend logic for links, shoots, status lookup, and pipeline feed
- `api/server.js` - local Aryeo integration API server
- `api/.env.example` - required environment variables
- `data/lead-pipeline.jsonl` - local lead pipeline event log (auto-created)
- `images/` - put your own photo files here

## Run locally

Run once:

```bash
cd /Users/chris/Domains/elevatephotograhy-website
cp api/.env.example api/.env
```

Edit `api/.env` and set:

```bash
ARYEO_API_TOKEN=your_real_token_here
WEBHOOK_SECRET=your_random_secret_here
# Optional cache tuning for faster portfolio loads
SHOOTS_CACHE_TTL_SECONDS=1800
```

Manual start (serves website + API from one server):

```bash
cd /Users/chris/Domains/elevatephotograhy-website
node api/server.js
```

Then open `http://127.0.0.1:8788`.

Optional helper scripts:

```bash
cd /Users/chris/Domains/elevatephotograhy-website
./scripts/start-local.sh
./scripts/stop-local.sh
```

## Customize for your brand

1. Update your name and email in `index.html`.
2. Replace sample Unsplash image URLs with your own files in `images/`.
3. Edit colors/fonts in `styles.css` variables under `:root`.

## Aryeo setup

1. Open `site-config.js`.
2. Keep `order_page` set to `order.html`.
3. Set `api_base` to `""` for same-origin requests when site and API run on one domain.
4. Set `aryeo_order_form` and `aryeo_portal`.

## Features now live

1. Portfolio auto-loads Aryeo shoots from `GET /api/shoots`.
2. Order page provides live status lookup via `GET /api/order-status?order_id=...`.
3. Lead pipeline captures webhook events from `POST /api/webhooks/aryeo` and displays recent entries from `GET /api/pipeline/leads`.

## Portfolio performance cache

- `/api/shoots` now caches Aryeo results on the backend and serves from cache for fast repeat loads.
- Default refresh interval is every 30 minutes (`SHOOTS_CACHE_TTL_SECONDS=1800`).
- When cache is stale, `/api/shoots` refreshes before responding so new shoots sync faster.
- You can force an immediate refresh with `/api/shoots?limit=24&refresh=1`.

## Aryeo webhook target

Set your Aryeo webhook URL to:

`https://your-domain.com/api/webhooks/aryeo`

For local testing:

`http://127.0.0.1:8788/api/webhooks/aryeo`

Include header:

`x-webhook-secret: <WEBHOOK_SECRET>`

## Deploy to Railway (single host)

1. Create a Railway project from this GitHub repo.
2. Start command: `npm start`
3. Add service variables:
   - `ARYEO_API_TOKEN`
   - `WEBHOOK_SECRET`
   - `ARYEO_API_BASE=https://api.aryeo.com/v1`
  - `SHOOTS_CACHE_TTL_SECONDS=1800`
4. Generate a public Railway domain and then attach your custom domain.
5. Point DNS `www` CNAME to Railway's provided target.

## Production workflow

- Railway is your only public frontend + API endpoint.
- GitHub Pages is disabled.
- For future updates:
  1. edit locally
  2. `git add` / `git commit`
  3. `git push origin main`
  4. Railway auto-deploys
