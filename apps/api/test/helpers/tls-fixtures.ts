import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TlsPair {
  cert: string;
  key: string;
}

/**
 * A real self-signed certificate and matching private key, generated on the
 * fly with openssl. Tests that exercise material validation need PEM that
 * actually parses; nothing is committed to the repository.
 */
export function generateTlsPair(commonName = 'betterdb-test'): TlsPair {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-pair-'));
  try {
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', `/CN=${commonName}`, '-days', '1'],
      { stdio: 'ignore' },
    );
    return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
