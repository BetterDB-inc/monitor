import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ValidationPipe,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { AdminGuard } from '../admin/admin.guard';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
@UseGuards(AdminGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  createUser(@Body(new ValidationPipe({ whitelist: true })) dto: CreateUserDto) {
    return this.userService.createUser(dto);
  }

  @Get('by-email/:email')
  async getUserByEmail(@Param('email') email: string) {
    const user = await this.userService.getUserByEmail(decodeURIComponent(email));
    if (!user) {
      throw new NotFoundException(`No user found with email ${email}`);
    }
    return user;
  }

  @Get('by-tenant/:tenantId')
  getUsersByTenant(@Param('tenantId') tenantId: string) {
    return this.userService.getUsersByTenant(tenantId);
  }

  @Get(':id')
  getUser(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    // Scope to the caller's workspace so a tenant can't read another
    // tenant's user record by id.
    return this.userService.getUserForTenant(id, tenantId);
  }

  @Delete(':id')
  deleteUser(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    return this.userService.deleteUser(id, tenantId);
  }
}
