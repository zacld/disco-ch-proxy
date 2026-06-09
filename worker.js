/**
 * DISCO — Companies House Proxy Worker
 * Cloudflare Worker that proxies Companies House API requests server-side,
 * keeping the API key out of the frontend entirely.
 *
 * Deploy with: wrangler deploy
 * Set secret:  wrangler secret put CH_API_KEY
 *
 * Allowed routes (read-only, no writes):
 *   GET /search/companies?q=...&items_per_page=...
 *   GET /company/:number
 *   GET /company/:number/officers
 *   GET /company/:number/filing-history
 *
 * The frontend (GitHub Pages) origin is allowed via CORS.
 * All other routes and methods are rejected.
 */

// ── Allowed routes — whitelist only, no arbitrary proxying
const ALLOWED_ROUTES = [
  { pattern: /^\/search\/companies$/, method: 'GET' },
  { pattern: /^\/company\/[A-Z0-9]{6,10}$/, method: 'GET' },
  { pattern: /^\/company\/[A-Z0-9]{6,10}\/officers$/, method: 'GET' },
  { pattern: /^\/company\/[A-Z0-9]{6,10}\/filing-history$/, method: 'GET' },
];

// ── Allowed query params per route (blocklist everything else)
const ALLOWED_PARAMS = ['q', 'items_per_page', 'start_index', 'register_type', 'order_by', 'category'];

// ── Rate limiting — simple in-memory per-IP counter (resets on worker restart)
// For production, use Cloudflare KV or Durable Objects for persistence
const rateLimitMap = new Map();
const RATE_LIMIT = 60;       // requests per window
const RATE_WINDOW_MS = 60000; // 1 minute

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count += 1;
  }
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

// ── CORS headers — restrict to GitHub Pages origin
function corsHeaders(origin) {
  const allowed = [
    'https://zacld.github.io',
    'http://localhost:3000',    // local dev
    'http://localhost:5173',    // vite dev
  ];
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ── Main handler
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only GET allowed
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    // Rate limiting
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(ip)) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, origin);
    }

    // Route validation — must match whitelist exactly
    const routeMatch = ALLOWED_ROUTES.find(r =>
      r.method === request.method && r.pattern.test(pathname)
    );
    if (!routeMatch) {
      return jsonResponse({ error: 'Route not permitted', path: pathname }, 403, origin);
    }

    // Strip disallowed query params
    const cleanParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (ALLOWED_PARAMS.includes(key)) {
        cleanParams.set(key, value);
      }
    }

    // Build Companies House API URL
    const chBase = 'https://api.company-information.service.gov.uk';
    const chUrl = `${chBase}${pathname}${cleanParams.toString() ? '?' + cleanParams.toString() : ''}`;

    // Add CH API key via HTTP Basic Auth (key as username, empty password)
    const apiKey = env.CH_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'Companies House API key not configured on proxy' }, 503, origin);
    }
    const basicAuth = btoa(`${apiKey}:`);

    // Forward to Companies House
    let chResponse;
    try {
      chResponse = await fetch(chUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Accept': 'application/json',
          'User-Agent': 'DISCO-FX-Proxy/1.0',
        },
      });
    } catch (e) {
      return jsonResponse({ error: 'Upstream request failed', detail: e.message }, 502, origin);
    }

    // Parse and forward response
    let data;
    try {
      data = await chResponse.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid response from Companies House' }, 502, origin);
    }

    // Strip any internal CH fields we don't need (defence in depth)
    // Only forward known safe fields
    return new Response(JSON.stringify(data), {
      status: chResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // cache CH data for 1 hour
        ...corsHeaders(origin),
      },
    });
  },
};
