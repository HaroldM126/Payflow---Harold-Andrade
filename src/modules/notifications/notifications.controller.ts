import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../entities/user/user.entity';
import { NotificationsService } from './notifications.service';
import { GetNotificationsQueryDto } from './dtos/get-notifications.query.dto';
import { MarkNotificationReadDto } from './dtos/mark-notification-read.dto';

interface RequestWithUser extends Request {
  user: {
    id: number;
    email: string;
    role: string;
  };
}

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Obtener notificaciones del usuario autenticado' })
  @ApiResponse({ status: 200, description: 'Listado de notificaciones del usuario autenticado' })
  async getMyNotifications(@Req() req: RequestWithUser, @Query() query: GetNotificationsQueryDto) {
    return this.notificationsService.findNotifications(req.user.id, false, query);
  }

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Obtener todas las notificaciones (ADMIN)' })
  @ApiResponse({ status: 200, description: 'Listado completo de notificaciones' })
  async getAllNotifications(@Query() query: GetNotificationsQueryDto) {
    return this.notificationsService.findNotifications(0, true, query);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marcar una notificación como leída o no leída' })
  @ApiParam({ name: 'id', description: 'ID de la notificación' })
  @ApiResponse({ status: 200, description: 'Notificación actualizada correctamente' })
  async markAsRead(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: MarkNotificationReadDto,
    @Req() req: RequestWithUser,
  ) {
    const read = body.read ?? true;
    return this.notificationsService.markAsRead(id, req.user.id, req.user.role === Role.ADMIN, read);
  }
}
