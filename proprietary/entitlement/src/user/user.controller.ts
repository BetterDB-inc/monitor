import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
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
  async getUser(@Param('id') id: string) {
    const user = await this.userService.getUser(id);
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  @Delete(':id')
  deleteUser(@Param('id') id: string) {
    return this.userService.deleteUser(id);
  }
}
