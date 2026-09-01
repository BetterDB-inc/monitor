interface GhsaTokenNoticeProps {
  show: boolean;
}

export function GhsaTokenNotice({ show }: GhsaTokenNoticeProps) {
  if (show === false) {
    return null;
  }

  return (
    <p data-testid="ghsa-token-notice" className="text-muted-foreground text-[13px] leading-5">
      GitHub allows 60 requests an hour per address without a token. Set{' '}
      <span className="bg-muted text-foreground rounded px-1.5 py-px font-mono text-xs">
        CVE_GITHUB_TOKEN
      </span>{' '}
      to raise it to 5,000.
    </p>
  );
}
