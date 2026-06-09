# DISCO — Companies House Proxy Worker

A minimal Cloudflare Worker that proxies Companies House API requests, keeping the API key server-side and out of the public GitHub Pages frontend.

## Architecture

```
Browser (GitHub Pages)
  → DISCO frontend (zacld.github.io/disco)
    → Cloudflare Worker (this repo)
      → Companies House API (api.company-information.service.gov.uk)
```

The CH API key never touches the browser.

## Setup (5 minutes)

### 1. Get a Companies House API key

- Go to https://developer.company-information.service.gov.uk
- Sign in / register
- Create an application → get a Live API key

### 2. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 3. Deploy the worker

```bash
cd disco-ch-proxy
wrangler deploy
```

Wrangler will print your worker URL, e.g.:
`https://disco-ch-proxy.<your-account>.workers.dev`

### 4. Add your CH API key as a secret (never in code)

```bash
wrangler secret put CH_API_KEY
# paste your key when prompted — it stays encrypted server-side
```

### 5. Wire the frontend

In `disco/index.html`, find `ENRICHMENT_CONFIG` and set:

```js
const ENRICHMENT_CONFIG = {
  companiesHouseProxyUrl: "https://disco-ch-proxy.<your-account>.workers.dev",
  websiteProxyUrl: "https://api.allorigins.win/raw?url=",
  enableDirectCompaniesHouse: false
};
```

Commit and push `index.html` to GitHub. Done.

## Allowed routes

The worker only proxies these four read-only routes:

| Route | Purpose |
|---|---|
| `GET /search/companies?q=...` | Find company by name |
| `GET /company/:number` | Company profile + SIC codes |
| `GET /company/:number/officers` | Active officers |
| `GET /company/:number/filing-history` | Filing history |

All other routes return `403 Route not permitted`. No writes are possible.

## Rate limiting

60 requests per IP per minute (in-memory, resets on worker restart).
For persistent rate limiting, upgrade to Cloudflare KV or Durable Objects.

## CORS

Only `https://zacld.github.io` and `localhost` are allowed origins.
Update `corsHeaders()` in `worker.js` if you host DISCO on a different domain.

## Testing the worker locally

```bash
wrangler dev
```

Then in a browser console or curl:
```bash
curl "http://localhost:8787/search/companies?q=Delta+Process+Equipment"
curl "http://localhost:8787/company/12345678/officers"
```

## Security properties

- CH API key stored as encrypted Cloudflare secret, never in code or logs
- CORS restricted to GitHub Pages origin
- Route whitelist — no arbitrary URL proxying
- Query param sanitisation — only known params forwarded
- Read-only — no POST/PUT/DELETE
- Rate limited per IP
- Cache-Control: 1 hour on CH responses (reduces API usage)
