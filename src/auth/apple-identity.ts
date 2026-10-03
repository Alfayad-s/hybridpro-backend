import { createPublicKey, verify, type JsonWebKey } from 'crypto';

const APPLE_KEYS = 'https://appleid.apple.com/auth/keys';
const APPLE_ISS = 'https://appleid.apple.com';

type AppleJwk = JsonWebKey & { kid?: string };

type AppleIdentity = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
};

let cachedKeys: { keys: AppleJwk[]; expiresAt: number } | null = null;

export function appleBundleId() {
  return (process.env.APPLE_BUNDLE_ID || 'in.hybridpro.hybridProApp').trim();
}

/** Verify a native Sign in with Apple identity token against Apple's JWKS. */
export async function verifyAppleIdentityToken(identityToken: string): Promise<AppleIdentity> {
  const parts = identityToken.split('.');
  if (parts.length !== 3) throw new Error('Apple identity token is invalid');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader) as { alg?: string; kid?: string };
  const payload = decodeJson(encodedPayload) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
  };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Apple identity token is invalid');
  }

  const jwk = (await appleKeys()).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error('Apple identity token could not be verified');

  const signatureOk = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!signatureOk) throw new Error('Apple identity token could not be verified');

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== APPLE_ISS || !audiences.includes(appleBundleId())) {
    throw new Error('Apple identity token is for a different app');
  }
  if (!payload.exp || payload.exp <= now) {
    throw new Error('Apple identity token has expired');
  }
  const sub = payload.sub?.trim() || '';
  if (!sub) throw new Error('Apple account is missing an id');

  const email = payload.email?.trim().toLowerCase() || null;
  const emailVerified =
    payload.email_verified === true || payload.email_verified === 'true' || email == null;

  return { sub, email, emailVerified };
}

async function appleKeys() {
  const now = Date.now();
  if (cachedKeys && cachedKeys.expiresAt > now) return cachedKeys.keys;
  const res = await fetch(APPLE_KEYS);
  const body = (await res.json().catch(() => ({}))) as { keys?: AppleJwk[] };
  if (!res.ok || !body.keys?.length) {
    throw new Error('Apple sign-in is unavailable right now');
  }
  cachedKeys = { keys: body.keys, expiresAt: now + 60 * 60 * 1000 };
  return body.keys;
}

function decodeJson(segment: string) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('Apple identity token is invalid');
  }
}
