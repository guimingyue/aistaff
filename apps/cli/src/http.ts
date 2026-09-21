const BASE = process.env.AISTAFF_CORE_URL ?? 'http://127.0.0.1:3000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message ?? text;
    } catch {}
    throw new Error(`core ${path} -> HTTP ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as T;
}

export function coreRequest<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function corePatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
