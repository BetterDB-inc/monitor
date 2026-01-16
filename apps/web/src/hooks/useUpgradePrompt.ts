import { createContext, useContext, useState } from 'react';
import { PaymentRequiredError } from '../api/client';

interface UpgradePromptContextValue {
  error: PaymentRequiredError | null;
  showUpgradePrompt: (error: PaymentRequiredError) => void;
  dismissUpgradePrompt: () => void;
}

export const UpgradePromptContext = createContext<UpgradePromptContextValue>({
  error: null,
  showUpgradePrompt: () => {},
  dismissUpgradePrompt: () => {},
});

export function useUpgradePrompt() {
  return useContext(UpgradePromptContext);
}

export function useUpgradePromptState() {
  const [error, setError] = useState<PaymentRequiredError | null>(null);

  const showUpgradePrompt = (err: PaymentRequiredError) => {
    setError(err);
  };

  const dismissUpgradePrompt = () => {
    setError(null);
  };

  return {
    error,
    showUpgradePrompt,
    dismissUpgradePrompt,
  };
}
