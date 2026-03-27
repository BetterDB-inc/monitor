import { Info } from 'lucide-react';

export function InfoTip({ text }: { text: string }) {
  return (
    <Info
      className="inline w-3.5 h-3.5 text-muted-foreground cursor-help ml-1"
      data-tooltip-id="info-tip"
      data-tooltip-content={text}
    />
  );
}
