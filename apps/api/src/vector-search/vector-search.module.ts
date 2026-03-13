import { Module } from '@nestjs/common';
import { VectorSearchController } from './vector-search.controller';
import { VectorSearchService } from './vector-search.service';

@Module({
  controllers: [VectorSearchController],
  providers: [VectorSearchService],
  exports: [VectorSearchService],
})
export class VectorSearchModule {}
