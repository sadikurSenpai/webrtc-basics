// REST client for the MAIN BACKEND (accounts, friends, call history, config).
// By default it calls "/api/..." on the frontend's own origin, and the Vite
// dev server proxies that to BACKEND_URL (see vite.config.js and .env).
import { log } from './timeline.js';

const BASE = import.meta.env.VITE_API_BASE || '/api';
// sessionStorage (not localStorage): each tab has its own login, so you can
// test as two users in two tabs of the same browser.
const TOKEN_KEY = 'uc.token';

export const session = {
  get token() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v) { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch {} },
  onUnauthorized: () => {},
};

export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const headers = { 'ngrok-skip-browser-warning': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;

  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!quiet) log('api', `${method} /api${path} → ${res.status}`);

  if (res.status === 401 && session.token && path !== '/auth/login') session.onUnauthorized();
  if (!res.ok) throw new Error(formatError(data) || `${res.status} ${res.statusText}`);
  return data;
}

function formatError(data) {
  const d = data?.detail;
  if (Array.isArray(d)) return d.map((e) => `${e.loc?.at(-1)}: ${e.msg}`).join(', '); // pydantic validation
  return d;
}
