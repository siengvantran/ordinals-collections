// API client. In preview mode requests go to the in-browser LocalServer; with
// a backend they go to the words-api Edge Function with the player's Supabase
// session token. Either way the contract is the same (docs/API.md).
import { CONFIG, PREVIEW } from './config.js';
import { ApiError } from './core/errors.js';

export { PREVIEW };

const STATE_KEY = 'words_preview_state';
const USER_KEY = 'words_preview_user';

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode: state lasts for this page only */ }
}

// ---------------------------------------------------------------------------
// Preview backend
// ---------------------------------------------------------------------------

let localPromise;
function local() {
  localPromise ??= (async () => {
    const [{ LocalServer }, { parseDictionary }] = await Promise.all([
      import('./server/local-server.js'),
      import('./core/solver.js')
    ]);
    let memory = null;
    const store = {
      load: () => {
        const s = storageGet(STATE_KEY);
        try { return s ? JSON.parse(s) : memory; } catch { return memory; }
      },
      save: (state) => {
        memory = state;
        storageSet(STATE_KEY, JSON.stringify(state));
      }
    };
    const loadWords = async () => {
      const res = await fetch(new URL('../data/dictionary.txt', import.meta.url));
      if (!res.ok) throw new Error('dictionary unavailable');
      return parseDictionary(await res.text());
    };
    const server = new LocalServer({ loadWords, store });
    server.save();
    return server;
  })();
  return localPromise;
}

// ---------------------------------------------------------------------------
// Supabase backend
// ---------------------------------------------------------------------------

let sbPromise;
export function supabase() {
  sbPromise ??= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm').then(({ createClient }) =>
    createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } })
  );
  return sbPromise;
}

async function accessToken() {
  const { data } = await (await supabase()).auth.getSession();
  return data.session?.access_token ?? null;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export const auth = {
  /** {user_id, email} or null */
  async current() {
    if (PREVIEW) {
      const id = storageGet(USER_KEY);
      return id ? { user_id: id } : null;
    }
    const { data } = await (await supabase()).auth.getSession();
    const u = data.session?.user;
    return u ? { user_id: u.id, email: u.email } : null;
  },

  /** Preview: signs in at once. Live: emails a magic link that returns to `redirectPath`. */
  async signIn(email, redirectPath = location.pathname) {
    if (PREVIEW) {
      const { user_id } = await api('POST', '/auth/preview-sign-in', { email });
      storageSet(USER_KEY, user_id);
      return { signedIn: true };
    }
    const sb = await supabase();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: new URL(redirectPath, location.origin).href } });
    if (error) throw new ApiError(400, 'sign_in_failed', error.message);
    return { signedIn: false, sent: true };
  },

  async signOut() {
    if (PREVIEW) storageSet(USER_KEY, null);
    else await (await supabase()).auth.signOut();
  }
};

/**
 * Call the API. Resolves to the response body; rejects with ApiError.
 * Network failures reject with status 0 and code 'offline'.
 */
export async function api(method, path, body = null) {
  if (PREVIEW) {
    const server = await local();
    server.reload();
    const id = storageGet(USER_KEY);
    const res = await server.handle(method, path, body ?? {}, id ? { user_id: id } : null);
    if (res.status >= 400) throw new ApiError(res.status, res.body.error, res.body.message, res.body.details);
    return res.body;
  }
  const headers = { apikey: CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' };
  const token = await accessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/words-api${path}`, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
    });
  } catch {
    throw new ApiError(0, 'offline', 'You seem to be offline. We’ll keep trying.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'server_error', data.message ?? 'Something went wrong.', data.details);
  return data;
}

/** Preview only: wipe everything in this browser. */
export function resetPreview() {
  storageSet(STATE_KEY, null);
  storageSet(USER_KEY, null);
}
