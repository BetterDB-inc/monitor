import {
  Controller,
  Post,
  Body,
  UseGuards,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { AdminGuard } from '../admin/admin.guard';
import { GenerateWorkspaceTokenDto } from './dto/generate-workspace-token.dto';

@Controller('auth')
@UseGuards(AdminGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
  ) {}

  @Post('workspace-token')
  async generateWorkspaceToken(
    @Body(new ValidationPipe({ whitelist: true })) dto: GenerateWorkspaceTokenDto,
  ) {
    const user = await this.userService.getUserByEmail(dto.email);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const token = this.authService.generateWorkspaceToken({
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId,
      subdomain: user.tenant.subdomain,
      role: user.role,
    });

    return { token, subdomain: user.tenant.subdomain };
  }
}
