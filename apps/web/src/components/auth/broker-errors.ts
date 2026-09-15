const BROKER_ERROR_MESSAGES: Record<string, string> = {
  not_invited: 'No invitation matches that account. Ask a workspace admin for an invite.',
  expired: 'That sign-in link expired. Try again.',
  invalid: 'Sign-in with Google or GitHub failed. Try again.',
};

export function brokerErrorMessage(code: string | null): string | null {
  if (code === null) {
    return null;
  }
  return BROKER_ERROR_MESSAGES[code] ?? null;
}
