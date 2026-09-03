import { Controller, Get, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CveDatasetStatus, CveScanResult } from '@betterdb/shared';
import { ConnectionId } from '../common/decorators';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { requireConnectionId } from '../connections/require-connection-id';
import { CveService } from './cve.service';

@ApiTags('cve')
@Controller('cve')
export class CveController {
  constructor(
    private readonly cveService: CveService,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  @Get('scan')
  @ApiOperation({ summary: 'CVEs matching this connection, per node for a cluster' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getScan(@ConnectionId() connectionId?: string): Promise<CveScanResult> {
    const resolvedId = requireConnectionId(this.connectionRegistry, connectionId);

    return this.cveService.getScan(resolvedId);
  }

  @Post('scan/refresh')
  @ApiOperation({ summary: 'Force a rescan of this connection against the current dataset' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async refreshScan(@ConnectionId() connectionId?: string): Promise<CveScanResult> {
    const resolvedId = requireConnectionId(this.connectionRegistry, connectionId);

    return this.cveService.refreshScan(resolvedId);
  }

  @Get('dataset')
  @ApiOperation({ summary: 'Advisory dataset age, version and per-source health' })
  async getDataset(): Promise<CveDatasetStatus> {
    return this.cveService.getDataset();
  }
}
