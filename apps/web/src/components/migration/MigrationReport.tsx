import type { MigrationAnalysisResult } from '@betterdb/shared';
import { SummarySection } from './sections/SummarySection';
import { VerdictSection } from './sections/VerdictSection';
import { DataTypeSection } from './sections/DataTypeSection';
import { TtlSection } from './sections/TtlSection';
import { CommandSection } from './sections/CommandSection';
import { HfeSection } from './sections/HfeSection';

interface Props {
  job: MigrationAnalysisResult;
}

export function MigrationReport({ job }: Props) {
  return (
    <div className="space-y-6 print:space-y-4" id="migration-report">
      <SummarySection job={job} />
      <VerdictSection job={job} />
      <DataTypeSection job={job} />
      <TtlSection job={job} />
      <CommandSection job={job} />
      <HfeSection job={job} />
    </div>
  );
}
