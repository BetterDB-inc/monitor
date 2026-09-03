import { Module } from '@nestjs/common';
import { ClusterModule } from '../cluster/cluster.module';
import { StorageModule } from '../storage/storage.module';
import { CVE_ENRICHMENT_SOURCES, CVE_MITRE_SOURCE, CVE_SOURCES, ghsaToken } from './cve.constants';
import { CveController } from './cve.controller';
import { CveRefreshService } from './cve-refresh.service';
import { CveScanService } from './cve-scan.service';
import { CveService } from './cve.service';
import type {
  CveSource,
  EnrichmentSource,
  FetchLike,
  MitreLikeSource,
} from './sources/cve-source.interface';
import { EpssSource } from './sources/epss.source';
import { GhsaSource } from './sources/ghsa.source';
import { KevSource } from './sources/kev.source';
import { MitreSource } from './sources/mitre.source';
import { NvdSource } from './sources/nvd.source';

const httpFetch: FetchLike = (input, init) => {
  return fetch(input, init);
};

@Module({
  imports: [StorageModule, ClusterModule],
  controllers: [CveController],
  providers: [
    CveService,
    CveScanService,
    CveRefreshService,
    {
      provide: CVE_SOURCES,
      useFactory: (): CveSource[] => {
        return [new GhsaSource(httpFetch, ghsaToken()), new NvdSource(httpFetch)];
      },
    },
    {
      provide: CVE_ENRICHMENT_SOURCES,
      useFactory: (): EnrichmentSource[] => {
        return [new KevSource(httpFetch), new EpssSource(httpFetch)];
      },
    },
    {
      provide: CVE_MITRE_SOURCE,
      useFactory: (): MitreLikeSource => {
        return new MitreSource(httpFetch);
      },
    },
  ],
  exports: [CveService],
})
export class CveModule {}
