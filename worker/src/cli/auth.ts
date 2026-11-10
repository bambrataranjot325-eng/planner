import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { log, type Env } from '../config.js';
import { Db } from '../db.js';
import { buildAuthUrl, exchangeCode } from '../gmail/auth.js';
import { makeGmailApi } from '../gmail/client.js';

/**
 * One-off sign-in for an inbox. Run on the server through an SSH tunnel (see README),
 * open the printed link in your own browser, and the refresh token goes straight into
 * Supabase Vault. It is never printed or written to disk.
 */
export async function authCommand(env: Env): Promise<void> {
  const redirect = new URL(env.OAUTH_REDIRECT_URI);
  const state = randomBytes(16).toString('hex');
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, env.USER_ID);

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', redirect.origin);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (code: number, text: string, err?: Error) => {
        res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
        server.close();
        err ? reject(err) : resolve();
      };
      try {
        if (url.searchParams.get('state') !== state) return finish(400, 'State mismatch. Start again.', new Error('state mismatch'));
        const code = url.searchParams.get('code');
        if (!code) return finish(400, `Google returned: ${url.searchParams.get('error') ?? 'no code'}`, new Error('no code'));
        const tokens = await exchangeCode(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, code, env.OAUTH_REDIRECT_URI);
        if (!tokens.refreshToken) return finish(500, 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.', new Error('no refresh token'));
        const profile = await makeGmailApi(tokens.accessToken).getProfile();
        const sourceId = await db.upsertGmailSource(profile.emailAddress, profile.emailAddress.split('@')[0] ?? 'Gmail');
        await db.setSecret(sourceId, tokens.refreshToken);
        log('inbox_connected', { account: profile.emailAddress });
        finish(200, `Connected ${profile.emailAddress}. You can close this tab.`);
      } catch (e) {
        finish(500, 'Something went wrong. Check the terminal.', e as Error);
      }
    });
    server.listen(Number(redirect.port || 80), '0.0.0.0', () => {
      console.log('\nOpen this link in your browser and sign in with the inbox you want to connect:\n');
      console.log(buildAuthUrl(env.GOOGLE_CLIENT_ID, env.OAUTH_REDIRECT_URI, state));
      console.log('\nWaiting for Google to redirect back...\n');
    });
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 10 minutes'));
    }, 600_000).unref();
  });
}
