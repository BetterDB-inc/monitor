import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLicense } from '../../hooks/useLicense';

export function CommunityBanner() {
  const { tier } = useLicense();
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('community-banner-dismissed') === 'true',
  );

  if (tier !== 'community' || dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('community-banner-dismissed', 'true');
  };

  return (
    <div className="mx-3 mb-2 p-2.5 bg-primary/5 border border-primary/20 rounded-lg text-xs">
      <div className="flex items-start justify-between gap-1">
        <div>
          <span className="text-foreground">Running on Community.</span>{' '}
          <Link to="/settings" className="text-primary hover:underline font-medium">
            Register free to unlock all Enterprise features.
          </Link>
        </div>
        <button
          onClick={handleDismiss}
          className="text-muted-foreground hover:text-foreground flex-shrink-0 mt-0.5"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
