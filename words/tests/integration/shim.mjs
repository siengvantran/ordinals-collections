// Test-only stand-in for the two Supabase endpoints words-api uses:
//   POST /rest/v1/rpc/<fn>  -> public.<fn>(named args) via psql
//   GET  /auth/v1/user      -> the user for a bearer token ("token-<email>")
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const [port, psqlArgsJson] = process.argv.slice(2);
const psqlArgs = JSON.parse(psqlArgsJson);
const sql = (q) => execFileSync('psql', [...psqlArgs, '-tAX', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
const lit = (s) => `$J$${s}$J$`;
const users = new Map();

createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.url === '/auth/v1/user') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const m = /^token-(.+)$/.exec(token);
      if (!m) return send(401, { message: 'invalid token' });
      const email = m[1];
      if (!users.has(email)) {
        const id = sql(`insert into auth.users (email) values (${lit(email)}) returning id`).split('\n')[0];
        users.set(email, id);
      }
      return send(200, { id: users.get(email), email, aud: 'authenticated', role: 'authenticated' });
    }
    const m = /^\/rest\/v1\/rpc\/(\w+)/.exec(req.url);
    if (m) {
      const out = JSON.parse(sql(`select public.test_call(${lit(m[1])}, ${lit(body || '{}')}::jsonb)`));
      if (out.error) return send(400, { code: 'P0001', ...out.error });
      return send(200, out.data);
    }
    send(404, { message: 'not found' });
  } catch (e) {
    send(500, { message: String(e.message) });
  }
}).listen(Number(port));
