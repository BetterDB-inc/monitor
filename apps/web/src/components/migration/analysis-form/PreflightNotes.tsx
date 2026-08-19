import type { PreflightNote, PreflightTone } from './preflight';

interface Props {
  notes: PreflightNote[];
}

const TONE_CLASS: Record<PreflightTone, string> = {
  ok: 'bg-success text-success-foreground',
  info: 'bg-chart-info text-white',
  warning: 'bg-chart-warning text-black',
};

const TONE_GLYPH: Record<PreflightTone, string> = {
  ok: '✓',
  info: 'i',
  warning: '!',
};

export function PreflightNotes({ notes }: Props) {
  if (notes.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-4">
      {notes.map((note) => {
        return (
          <li key={note.id} className="flex items-start gap-2.5 text-sm">
            <span
              aria-hidden="true"
              className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${TONE_CLASS[note.tone]}`}
            >
              {TONE_GLYPH[note.tone]}
            </span>
            {note.message}
          </li>
        );
      })}
    </ul>
  );
}
