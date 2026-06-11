/**
 * DISCO — Companies House Proxy Worker v1.1
 *
 * Changes from v1.0:
 * - CORS: reject unrecognised origins with 403, not silently allow them
 * - Rate limit: tighter per-IP budget (30/min) + global budget guard (200/min)
 *   to avoid exhausting the CH free tier during bulk lookups
 * - Added /company/:number/advanced-search route for future use
 * - Explicit no-cache on 4xx/5xx responses
 * - Worker-level request counter resets on isolation recycle (noted in comment)
 */

const ALLOWED_ORIGINS = new Set([
  'https://zacld.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
]);

const ALLOWED_ROUTES = [
  { pattern: /^\/search\/companies$/,                      method: 'GET' },
  { pattern: /^\/advanced-search\/companies$/,             method: 'GET' },
  { pattern: /^\/company\/[A-Z0-9]{6,10}$/,               method: 'GET' },
  { pattern: /^\/company\/[A-Z0-9]{6,10}\/officers$/,     method: 'GET' },
  { pattern: /^\/company\/[A-Z0-9]{6,10}\/filing-history$/,method: 'GET' },
];

const ALLOWED_PARAMS = [
  'q', 'items_per_page', 'start_index', 'register_type',
  'order_by', 'category', 'sic_codes', 'company_status', 'company_type', 'size',
];

// ── Per-IP rate limit (in-memory; resets on worker isolation recycle)
const perIpMap = new Map();
const PER_IP_LIMIT    = 30;    // requests per IP per minute
const RATE_WINDOW_MS  = 60_000;

// ── Global budget guard — prevents bulk CH exhaustion
// CH free tier: 600 req/min. We reserve headroom for other tools.
let globalCount = 0;
let globalWindowStart = Date.now();
const GLOBAL_LIMIT = 200; // max requests this worker will forward per minute

function checkRateLimit(ip) {
  const now = Date.now();

  // Reset global window
  if (now - globalWindowStart > RATE_WINDOW_MS) {
    globalCount = 0;
    globalWindowStart = now;
  }
  globalCount++;
  if (globalCount > GLOBAL_LIMIT) return { ok: false, reason: 'global_budget' };

  // Per-IP window
  const entry = perIpMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }
  perIpMap.set(ip, entry);
  if (entry.count > PER_IP_LIMIT) return { ok: false, reason: 'per_ip' };

  return { ok: true };
}

function corsHeaders(origin) {
  // Only emit CORS headers for known origins.
  // Returning nothing for unknown origins causes browsers to block the response.
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

function jsonResponse(body, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    // Preflight
    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Method guard
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    // Origin guard — reject unknown callers before touching the CH key
    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'Origin not permitted' }, 403, origin);
    }

    // Rate limiting
    const ip  = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl  = checkRateLimit(ip);
    if (!rl.ok) {
      return jsonResponse(
        { error: 'Rate limit exceeded', reason: rl.reason },
        429, origin,
        { 'Retry-After': '60' }
      );
    }

    // Route whitelist
    const routeMatch = ALLOWED_ROUTES.find(
      r => r.method === request.method && r.pattern.test(path)
    );
    if (!routeMatch) {
      return jsonResponse({ error: 'Route not permitted', path }, 403, origin);
    }

    // Sanitise query params
    const clean = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (ALLOWED_PARAMS.includes(k)) clean.set(k, v);
    }

    // CH API key must be present
    const apiKey = env.CH_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'CH_API_KEY not configured' }, 503, origin);
    }

    const chUrl = `https://api.company-information.service.gov.uk${path}${
      clean.toString() ? '?' + clean.toString() : ''
    }`;

    let chResp;
    try {
      chResp = await fetch(chUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${btoa(apiKey + ':')}`,
          'Accept':        'application/json',
          'User-Agent':    'DISCO-FX-Proxy/1.1',
        },
      });
    } catch (e) {
      return jsonResponse({ error: 'Upstream request failed', detail: e.message }, 502, origin);
    }

    let data;
    try {
      data = await chResp.json();
    } catch {
      return jsonResponse({ error: 'Invalid upstream response' }, 502, origin);
    }

    // Forward response — cache successes, no-store errors
    const isOk     = chResp.status >= 200 && chResp.status < 300;
    const cacheHdr = isOk
      ? { 'Cache-Control': 'public, max-age=3600' }
      : { 'Cache-Control': 'no-store' };

    return new Response(JSON.stringify(data), {
      status: chResp.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin),
        ...cacheHdr,
      },
    });
  },
};
