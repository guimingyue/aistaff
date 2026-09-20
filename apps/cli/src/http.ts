const BASE = process.env.AISTAFF_CORE_URL ?? 'http://127.0.0.1:3000';

export async function coreRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`core ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
