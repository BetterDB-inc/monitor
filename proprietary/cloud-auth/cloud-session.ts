import * as jwt from 'jsonwebtoken';
import type { CloudSessionPayload } from './cloud-actor';

const SESSION_COOKIE = 'betterdb_session';

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  const cookies = cookieHeader ?? '';
  const match = cookies.split(';').find((cookie: string) => {
    return cookie.trim().startsWith(`${name}=`);
  });
  return match?.split('=')[1]?.trim();
}

function isDemoHost(host: string | undefined): boolean {
  const demoHostname = process.env.DEMO_HOSTNAME ?? '';
  if (demoHostname.length === 0) {
    return false;
  }
  return (host ?? '') === demoHostname;
}

export function readCloudSession(
  cookieHeader: string | undefined,
  host: string | undefined,
): CloudSessionPayload | null {
  const sessionToken = readCookie(cookieHeader, SESSION_COOKIE);
  if (sessionToken === undefined || sessionToken.length === 0) {
    return null;
  }
  try {
    const payload = jwt.verify(sessionToken, process.env.SESSION_SECRET ?? '', {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload & CloudSessionPayload;
    if (isDemoHost(host) === true) {
      return payload;
    }
    const expectedSchema = `tenant_${payload.subdomain.replace(/-/g, '_')}`;
    if (expectedSchema !== (process.env.DB_SCHEMA ?? '')) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
