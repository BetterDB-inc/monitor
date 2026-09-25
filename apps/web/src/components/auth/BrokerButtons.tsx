import { ReactElement } from 'react';
import { apiUrl } from '../../api/client';
import { Button } from '@/components/ui/button';
import { useAuth } from '../../contexts/AuthContext';

interface BrokerButtonsProps {
  invite?: string;
  next?: string;
}

type Provider = 'google' | 'github';

const LABELS: Record<Provider, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

function startHref(
  provider: Provider,
  invite: string | undefined,
  next: string | undefined,
): string {
  const params = new URLSearchParams({ provider });
  if (invite !== undefined) {
    params.set('invite', invite);
  }
  if (next !== undefined) {
    params.set('next', next);
  }
  return apiUrl(`/auth/broker/start?${params.toString()}`);
}

export function BrokerButtons({ invite, next }: BrokerButtonsProps): ReactElement | null {
  const { brokerEnabled } = useAuth();
  if (brokerEnabled === false) {
    return null;
  }
  const providers: Provider[] = ['google', 'github'];
  return (
    <div className="space-y-2">
      <p className="text-center text-xs text-muted-foreground">or</p>
      {providers.map((provider) => {
        return (
          <Button key={provider} asChild variant="outline" className="w-full">
            <a href={startHref(provider, invite, next)}>{LABELS[provider]}</a>
          </Button>
        );
      })}
    </div>
  );
}
