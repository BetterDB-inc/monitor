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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DataTypeSection job={job} />
        <TtlSection job={job} />
      </div>
      <CommandSection job={job} />
      <HfeSection job={job} />
    </div>
  );
}
