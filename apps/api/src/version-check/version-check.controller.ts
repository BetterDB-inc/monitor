import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { VersionCheckService } from './version-check.service';
import type { VersionInfo } from '@betterdb/shared';

@ApiTags('version')
@Controller('version')
export class VersionCheckController {
  constructor(private readonly versionCheck: VersionCheckService) {}

  @Get()
  @ApiOperation({ summary: 'Get version information and update status' })
  @ApiOkResponse({ description: 'Version info with update availability' })
  getVersion(): VersionInfo {
    return this.versionCheck.getVersionInfo();
  }
}
