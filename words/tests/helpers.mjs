import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDictionary } from '../js/core/solver.js';
import { LocalServer } from '../js/server/local-server.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let words;
export function dictionary() {
  words ??= parseDictionary(readFileSync(join(root, 'data/dictionary.txt'), 'utf8'));
  return words;
}

/** A preview server with a controllable clock and in-memory storage. */
export function testServer({ at = '2026-11-02T12:00:00Z', seed = true } = {}) {
  const clock = { t: new Date(at).getTime() };
  let saved = null;
  const server = new LocalServer({
    loadWords: async () => dictionary(),
    store: { load: () => saved, save: (s) => (saved = JSON.parse(JSON.stringify(s))) },
    now: () => new Date(clock.t),
    seed
  });
  const call = async (method, path, body, auth) => server.handle(method, path, body, auth);
  const advance = (seconds) => (clock.t += seconds * 1000);
  return { server, call, advance, clock, saved: () => saved };
}

/** Sign in and create a profile. Returns the auth object. */
export async function newPlayer(call, email, name, referral_code) {
  const { body } = await call('POST', '/auth/preview-sign-in', { email });
  const auth = { user_id: body.user_id };
  const res = await call('POST', '/profile', { display_name: name, referral_code }, auth);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return auth;
}
