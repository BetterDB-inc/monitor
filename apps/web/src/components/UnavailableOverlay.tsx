import type { ReactNode } from 'react';
import { UnavailableMessage, UnavailableMessageProps } from './UnavailableMessage';

interface Props extends UnavailableMessageProps {
  children: ReactNode;
}

export function UnavailableOverlay({ children, ...messageProps }: Props) {
  return (
    <div className="relative">
      <div className="opacity-40 pointer-events-none">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <UnavailableMessage {...messageProps} />
      </div>
    </div>
  );
}
