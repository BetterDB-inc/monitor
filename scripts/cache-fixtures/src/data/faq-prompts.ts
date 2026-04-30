interface PromptTemplate {
  q: string;
  a: string;
}

const BILLING_TEMPLATES: PromptTemplate[] = [
  { q: 'How do I update my payment method?', a: 'Go to Settings > Billing > Payment Methods and click Update.' },
  { q: 'When is my next invoice?', a: 'Your next invoice generates on the first of each month.' },
  { q: 'Can I get a refund for last month?', a: 'Refunds are issued within 30 days of charge — contact support@example.com.' },
  { q: 'Why was my card declined?', a: 'Common reasons: expired card, insufficient funds, or bank fraud check. Try another card.' },
  { q: 'How do I download a receipt?', a: 'Open Billing > Invoice History and click Download PDF on the row.' },
  { q: 'Can I switch from monthly to annual billing?', a: 'Yes, in Settings > Billing > Plan, choose Annual to switch and prorate the difference.' },
  { q: 'Do you support purchase orders?', a: 'POs are supported on Enterprise plans. Email sales@example.com to set one up.' },
  { q: 'What payment methods do you accept?', a: 'Visa, Mastercard, AmEx, and ACH for Enterprise.' },
  { q: 'How do I add a billing contact?', a: 'In Settings > Billing > Contacts, click Add Billing Contact.' },
  { q: 'Why did my plan auto-renew?', a: 'All paid plans renew automatically. To disable, toggle Auto-renew in Billing.' },
];

const SUPPORT_TEMPLATES: PromptTemplate[] = [
  { q: 'Why am I getting a 500 error on the dashboard?', a: 'A 500 usually means a backend issue — check status.example.com and retry. If persistent, file a ticket.' },
  { q: 'My data export is stuck pending.', a: 'Exports can take up to 30 minutes for large datasets. If still pending after that, re-trigger from Account > Data > Export.' },
  { q: 'How do I reset my password?', a: 'Click "Forgot password?" on the login page. The reset link expires in 30 minutes.' },
  { q: 'Two-factor auth code is not arriving.', a: 'Check spam folder, or use the backup codes saved during 2FA setup. SMS may be delayed in some regions.' },
  { q: 'My account is locked after too many login attempts.', a: 'Locks auto-clear after 15 minutes. To unlock immediately, use the password reset flow.' },
  { q: 'Can I bulk-delete API keys?', a: 'Yes — in Settings > API Keys, select rows and click Delete Selected.' },
  { q: 'Why are some events missing from the activity feed?', a: 'Events are eventually consistent — most appear within 60 seconds. Verify clock sync on your client.' },
  { q: 'How do I configure SSO with Okta?', a: 'Settings > Security > SSO > Okta. Paste your Metadata URL and assign the BetterDB app to users.' },
  { q: 'A team member cannot access a project.', a: 'Check their role in Project Settings > Members. Viewer roles cannot access secrets.' },
  { q: 'Webhooks stopped firing after a deploy.', a: 'Check Webhook Logs for non-2xx responses. We auto-disable endpoints after 50 consecutive failures.' },
];

const PREFIX_VARIANTS = [
  '',
  'Hi, ',
  'Hello! ',
  'Hey there, ',
  'Quick question: ',
  'Sorry to bother you but ',
  'Question - ',
  'I need help: ',
];

const SUFFIX_VARIANTS = [
  '',
  ' Thanks!',
  ' Thank you in advance.',
  ' Please advise.',
  ' Any pointers?',
  ' Can you help?',
];

export interface GeneratedPrompt {
  prompt: string;
  response: string;
  category: 'billing' | 'support';
}

export function generateFaqPrompts(perTopic: number, seed = 42): GeneratedPrompt[] {
  const rng = mulberry32(seed);
  const out: GeneratedPrompt[] = [];

  for (let i = 0; i < perTopic; i += 1) {
    const tpl = BILLING_TEMPLATES[i % BILLING_TEMPLATES.length]!;
    out.push({
      prompt: vary(tpl.q, rng),
      response: tpl.a,
      category: 'billing',
    });
  }
  for (let i = 0; i < perTopic; i += 1) {
    const tpl = SUPPORT_TEMPLATES[i % SUPPORT_TEMPLATES.length]!;
    out.push({
      prompt: vary(tpl.q, rng),
      response: tpl.a,
      category: 'support',
    });
  }
  return out;
}

function vary(base: string, rng: () => number): string {
  const prefix = PREFIX_VARIANTS[Math.floor(rng() * PREFIX_VARIANTS.length)] ?? '';
  const suffix = SUFFIX_VARIANTS[Math.floor(rng() * SUFFIX_VARIANTS.length)] ?? '';
  return `${prefix}${base}${suffix}`;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
