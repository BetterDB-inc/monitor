import { useState } from 'react';
import { Card } from './ui/card';
import { registrationApi } from '../api/registration';

interface UpgradePromptProps {
  onDismiss: () => void;
  isCloudMode?: boolean;
  featureName?: string;
}

export function UpgradePrompt({ onDismiss, isCloudMode = false, featureName }: UpgradePromptProps) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const handleRegister = async () => {
    if (!email.trim()) return;
    setSubmitting(true);
    setRegError(null);
    try {
      await registrationApi.register(email.trim());
      setSuccess(true);
    } catch (err) {
      setRegError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <Card className="max-w-md p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold">
              {isCloudMode
                ? 'This feature requires an active license'
                : featureName
                  ? `Unlock ${featureName} — free with registration`
                  : 'This feature is free with registration'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {isCloudMode
                ? 'Your workspace license needs to be activated to access this feature.'
                : 'Get access to all Enterprise features at no cost.'}
            </p>
          </div>
          <button
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {isCloudMode ? (
          <div className="bg-muted/50 border rounded-md p-4">
            <p className="text-sm">Your license is managed through your workspace account.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Contact your workspace administrator or reach out to support for help.
            </p>
          </div>
        ) : success ? (
          <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md p-4">
            <p className="text-sm font-medium text-green-800 dark:text-green-200">Check your email for your license key</p>
            <p className="text-xs text-green-600 dark:text-green-400 mt-1">
              Activate it in Settings &gt; License to unlock all features.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                autoFocus
              />
              {regError && (
                <p className="text-sm text-destructive mt-1">{regError}</p>
              )}
            </div>
            <button
              onClick={handleRegister}
              disabled={submitting || !email.trim()}
              className="w-full bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:bg-muted disabled:cursor-not-allowed"
            >
              {submitting ? 'Sending...' : 'Get my free license key'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
