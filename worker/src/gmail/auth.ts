const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** The refresh token was revoked or has expired: the inbox needs me to sign in again. */
export class ReauthError extends Error {}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new ReauthError(data.error_description ?? 'invalid_grant');
    throw new Error(`Google token endpoint ${res.status}: ${data.error ?? 'unknown error'}`);
  }
  return data;
}

export async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const data = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return data.access_token as string;
}

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // and make sure Google actually returns one
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string | undefined }> {
  const data = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}
