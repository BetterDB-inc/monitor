const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
  'mail.com', 'email.com',
  'zoho.com', 'zohomail.com',
  'yandex.com', 'yandex.ru',
  'gmx.com', 'gmx.net',
  'fastmail.com',
  'tutanota.com', 'tuta.com',
  'hey.com',
  'pm.me',
]);

export function extractDomain(email: string): string {
  return email.split('@')[1].toLowerCase();
}

export function isPersonalEmail(email: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(extractDomain(email));
}
