import { useState } from 'react';
import { useVersionCheck } from '../hooks/useVersionCheck';

export function UpdateBanner() {
  const {
    updateAvailable,
    current,
    latest,
    releaseUrl,
    updateCommand,
    updateDocsUrl,
    dismissed,
    dismiss,
    loading,
  } = useVersionCheck();
  const [copied, setCopied] = useState(false);

  // Don't show if:
  // - Still loading
  // - No update available
  // - User dismissed this version
  if (loading || !updateAvailable || dismissed) {
    return null;
  }

  async function handleCopy() {
    if (!updateCommand) return;
    try {
      await navigator.clipboard.writeText(updateCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (non-secure context); ignore.
    }
  }

  return (
    <div className="bg-primary text-primary-foreground px-4 py-2 text-sm flex items-center justify-between gap-4">
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
        <span className="font-medium">Update available:</span>
        <span>
          v{current} &rarr; v{latest}
        </span>
        {/* Newer versions ship new features and security patches — say so, so
            the value of updating is explicit rather than a bare version bump. */}
        <span className="text-primary-foreground/80">
          Newer releases include new features and security fixes. We recommend
          using the latest version available.
        </span>

        {updateCommand && (
          <span className="flex items-center gap-1 ml-1">
            <code className="bg-primary-foreground/15 rounded px-1.5 py-0.5 font-mono text-xs">
              {updateCommand}
            </code>
            <button
              onClick={handleCopy}
              className="underline hover:no-underline cursor-pointer"
              aria-label="Copy update command"
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </span>
        )}

        {updateDocsUrl && (
          <a
            href={updateDocsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline ml-1"
          >
            {updateCommand ? 'Update guide' : 'How to update'}
          </a>
        )}

        {releaseUrl && (
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline ml-1"
          >
            Release notes
          </a>
        )}
      </div>
      <button
        onClick={dismiss}
        className="text-primary-foreground/80 hover:text-primary-foreground px-2 py-1 rounded hover:bg-primary-foreground/10 shrink-0 cursor-pointer"
        aria-label="Dismiss update notification"
      >
        Dismiss
      </button>
    </div>
  );
}
