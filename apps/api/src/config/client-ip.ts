import { IncomingMessage } from 'http';
import proxyAddr from '@fastify/proxy-addr';
import { TrustProxySetting } from './trust-proxy';

type TrustFn = (addr: string, index: number) => boolean;

function trustAll(): boolean {
  return true;
}

function compileTrust(setting: string): TrustFn {
  const values = setting.split(',').map((value) => {
    return value.trim();
  });
  return proxyAddr.compile(values);
}

function resolveTrustFn(setting: true | string): TrustFn {
  if (setting === true) {
    return trustAll;
  }
  return compileTrust(setting);
}

export function upgradeClientIp(request: IncomingMessage, setting: TrustProxySetting): string {
  if (setting === false) {
    return request.socket.remoteAddress ?? '';
  }
  const trustFn = resolveTrustFn(setting);
  const addrs = proxyAddr.all(request, trustFn);
  const lastAddr = addrs[addrs.length - 1];
  if (lastAddr === undefined) {
    return '';
  }
  return lastAddr;
}
