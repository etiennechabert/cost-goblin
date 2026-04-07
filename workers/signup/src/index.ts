interface Env {
  SIGNUPS: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
}

interface TurnstileResponse {
  success: boolean;
  'error-codes': string[];
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://costgoblin.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });
  const data = (await res.json()) as TurnstileResponse;
  return data.success;
}

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const existing = await kv.get(key);
  if (existing !== null) {
    const count = parseInt(existing, 10);
    if (count >= 3) return false;
    await kv.put(key, String(count + 1), { expirationTtl: 3600 });
    return true;
  }
  await kv.put(key, '1', { expirationTtl: 3600 });
  return true;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    const contentType = request.headers.get('Content-Type') ?? '';
    let email = '';
    let turnstileToken = '';
    let honeypot = '';

    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, string>;
      email = body['email'] ?? '';
      turnstileToken = body['cf-turnstile-response'] ?? '';
      honeypot = body['website'] ?? '';
    } else {
      const form = await request.formData();
      email = (form.get('email') as string | null) ?? '';
      turnstileToken = (form.get('cf-turnstile-response') as string | null) ?? '';
      honeypot = (form.get('website') as string | null) ?? '';
    }

    // Honeypot: bots fill hidden fields — silently accept to not tip them off
    if (honeypot.length > 0) {
      return json({ ok: true });
    }

    // Turnstile verification
    const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
    const turnstileValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
    if (!turnstileValid) {
      return json({ ok: false, error: 'Verification failed' }, 403);
    }

    // Rate limit: 3 submissions per IP per hour
    const allowed = await checkRateLimit(env.SIGNUPS, ip);
    if (!allowed) {
      return json({ ok: false, error: 'Too many requests' }, 429);
    }

    // Validate email
    email = email.toLowerCase().trim();
    if (!isValidEmail(email)) {
      return json({ ok: false, error: 'Invalid email' }, 400);
    }

    // Store in KV (email as key = natural dedup)
    await env.SIGNUPS.put(`signup:${email}`, JSON.stringify({
      email,
      timestamp: new Date().toISOString(),
      ip,
      userAgent: request.headers.get('User-Agent') ?? '',
    }));

    return json({ ok: true });
  },
} satisfies ExportedHandler<Env>;
