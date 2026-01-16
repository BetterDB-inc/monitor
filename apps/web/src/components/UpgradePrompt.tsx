import { Card } from './ui/card';
import { PaymentRequiredError } from '../api/client';

interface UpgradePromptProps {
  error: PaymentRequiredError;
  onDismiss: () => void;
}

export function UpgradePrompt({ error, onDismiss }: UpgradePromptProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <Card className="max-w-md p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold">Upgrade Required</h2>
            <p className="text-sm text-muted-foreground mt-1">
              This feature requires {error.requiredTier}
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

        <div className="space-y-2">
          <p className="text-sm">{error.message}</p>
          <div className="text-sm text-muted-foreground">
            <p>Current tier: <span className="font-medium">{error.currentTier}</span></p>
            <p>Required tier: <span className="font-medium">{error.requiredTier}</span></p>
          </div>
        </div>

        <div className="flex gap-3">
          <a
            href={error.upgradeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 text-center"
          >
            Upgrade Now
          </a>
          <button
            onClick={onDismiss}
            className="px-4 py-2 rounded-md text-sm font-medium hover:bg-muted"
          >
            Maybe Later
          </button>
        </div>
      </Card>
    </div>
  );
}
