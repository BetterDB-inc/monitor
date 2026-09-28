import type { ComponentType, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Card } from './card';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  action?: ReactNode;
  variant?: 'card' | 'inline';
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  variant = 'card',
  className,
}: EmptyStateProps) {
  const inline = variant === 'inline';
  const Title = inline ? 'p' : 'h2';
  const content = (
    <>
      {Icon ? <Icon aria-hidden className="mx-auto mb-3 h-10 w-10 opacity-50" /> : null}
      <Title className={inline ? 'mb-1 font-medium' : 'mb-2 text-lg font-medium'}>{title}</Title>
      {description ? <p className="mx-auto max-w-md text-sm">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </>
  );

  if (inline) {
    return <div className={cn('py-8 text-center text-muted-foreground', className)}>{content}</div>;
  }

  return <Card className={cn('p-8 text-center text-muted-foreground', className)}>{content}</Card>;
}
