const USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

export function maskUrlCredentials(url: string): string {
  return url.replace(USERINFO, '$1***@');
}
