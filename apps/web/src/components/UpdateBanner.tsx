import { useVersionCheck } from '../hooks/useVersionCheck';

export function UpdateBanner() {
  const { updateAvailable, current, latest, releaseUrl, dismissed, dismiss, loading } =
    useVersionCheck();

  // Don't show if:
  // - Still loading
  // - No update available
  // - User dismissed this version
  if (loading || !updateAvailable || dismissed) {
    return null;
  }

  return (
    <div className="bg-blue-600 text-white px-4 py-2 text-sm flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="font-medium">Update available:</span>
        <span>
          v{current} &rarr; v{latest}
        </span>
        {releaseUrl && (
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline ml-2"
          >
            View release notes
          </a>
        )}
      </div>
      <button
        onClick={dismiss}
        className="text-white/80 hover:text-white px-2 py-1 rounded hover:bg-white/10"
        aria-label="Dismiss update notification"
      >
        Dismiss
      </button>
    </div>
  );
}
