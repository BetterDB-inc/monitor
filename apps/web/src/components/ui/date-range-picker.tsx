import { useState, useRef, useEffect } from 'react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';

export interface DateRange {
  from: Date;
  to: Date;
}

interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange | undefined) => void;
  className?: string;
}

const presets = [
  { label: 'Last 24 hours', days: 1 },
  { label: 'Last 3 days', days: 3 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
];

// Parse YYYY-MM-DD string as local date (not UTC)
// new Date("2026-01-27") parses as UTC midnight, causing timezone issues
function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handlePresetClick = (days: number) => {
    const to = endOfDay(new Date());
    const from = startOfDay(subDays(new Date(), days));
    onChange?.({ from, to });
    setIsOpen(false);
  };

  const handleCustomApply = () => {
    if (customStart && customEnd) {
      onChange?.({
        from: startOfDay(parseLocalDate(customStart)),
        to: endOfDay(parseLocalDate(customEnd)),
      });
      setIsOpen(false);
    }
  };

  const handleClear = () => {
    onChange?.(undefined);
    setCustomStart('');
    setCustomEnd('');
    setIsOpen(false);
  };

  const formatDisplayValue = () => {
    if (!value) return 'All time';
    return `${format(value.from, 'MMM d, yyyy')} – ${format(value.to, 'MMM d, yyyy')}`;
  };

  return (
    <div ref={containerRef} className={`relative inline-block ${className || ''}`}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`
          inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md
          bg-background hover:bg-muted/50 transition-colors
          ${value ? 'border-primary/50' : 'border-input'}
        `}
      >
        <svg
          className="w-4 h-4 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <span className={value ? 'text-foreground' : 'text-muted-foreground'}>
          {formatDisplayValue()}
        </span>
        {value && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              handleClear();
            }}
            className="ml-1 text-muted-foreground hover:text-foreground"
          >
            ×
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-popover border rounded-lg shadow-lg min-w-[280px]">
          {/* Presets */}
          <div className="p-2 border-b">
            <div className="text-xs font-medium text-muted-foreground mb-2 px-2">Quick select</div>
            <div className="space-y-1">
              {presets.map((preset) => (
                <button
                  key={preset.days}
                  type="button"
                  onClick={() => handlePresetClick(preset.days)}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Range */}
          <div className="p-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">Custom range</div>
            <div className="flex gap-2 items-center">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="flex-1 px-2 py-1.5 text-sm border rounded bg-background"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="flex-1 px-2 py-1.5 text-sm border rounded bg-background"
              />
            </div>
            <button
              type="button"
              onClick={handleCustomApply}
              disabled={!customStart || !customEnd}
              className="mt-2 w-full px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
