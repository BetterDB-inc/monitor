import { useIsDemo } from '../contexts/DemoContext';
import { CloudUser } from '../api/workspace';

export function DemoBanner({ cloudUser }: { cloudUser: CloudUser | null }) {
  const isDemo = useIsDemo();
  if (!isDemo) return null;

  const domain = window.location.hostname.split('.').slice(1).join('.'); // app.betterdb.com
  const workspaceUrl = cloudUser
    ? `https://${cloudUser.subdomain}.${domain}`
    : 'https://betterdb.com/signup';
  const ctaLabel = cloudUser ? 'Go to your workspace' : 'Sign up';

  return (
    <div className="sticky top-0 z-50 w-full bg-primary text-primary-foreground text-sm py-2 px-4 flex items-center justify-between">
      <span>Demo workspace — read-only. Connect your own database to see your metrics.</span>
      <a href={workspaceUrl} className="underline font-medium">{ctaLabel}</a>
    </div>
  );
}
