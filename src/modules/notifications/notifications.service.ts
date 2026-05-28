import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Notification } from '../../entities/notification/notification.entity';
import { User } from '../../entities/user/user.entity';
import { NotificationsGateway } from './notifications.gateway';
import { ConnectedUsersService } from './connected-users.service';
import { UserService } from '../user/user.service';
import { MailService } from '../../mail/mail.service';
import { BankOperationEvent } from '../../events/bank-operation.event';
import { GetNotificationsQueryDto } from './dtos/get-notifications.query.dto';

export interface TransferNotificationPayload {
  transactionId?: number;
  type: string;
  amount: number;
  fromAccountId?: number;
  toAccountId?: number;
  fromUserId?: number;
  toUserId?: number;
  status: string;
  created_at?: Date;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly gateway: NotificationsGateway,
    private readonly connectedUsersService: ConnectedUsersService,
    private readonly userService: UserService,
    private readonly mailService: MailService,
  ) {}

  async createFromEvent(event: BankOperationEvent): Promise<Notification> {
    const user = await this.userRepository.findOne({ where: { id: event.userId } });
    if (!user) {
      throw new NotFoundException(`Usuario ${event.userId} no encontrado para notificación`);
    }

    const notification = this.notificationRepository.create({
      type: event.operationType,
      status: event.operationStatus,
      amount: Number(event.amount),
      fromAccountId: event.fromAccountId,
      toAccountId: event.toAccountId,
      transactionId: event.transactionId,
      message: event.message,
      payload: event.details,
      user,
      read: false,
    });

    return this.notificationRepository.save(notification);
  }

  async notifyTransfer(
    userId: number,
    payload: TransferNotificationPayload & { partnerEmail?: string; newBalance?: number },
  ) {
    try {
      const isConnected = this.isConnected(userId);

      if (isConnected) {
        this.logger.log(`📨 Enviando notificación vía WebSocket al usuario ${userId}`);

        if (payload.type === 'TRANSFER') {
          const isSender = payload.fromUserId === userId;
          if (isSender) {
            this.gateway.notifyTransferSent(userId, {
              transactionId: payload.transactionId || 0,
              amount: payload.amount,
              toEmail: payload.partnerEmail || 'usuario destinatario',
              newBalance: payload.newBalance !== undefined ? payload.newBalance : 0,
              timestamp: payload.created_at || new Date(),
              status: payload.status,
            });
          } else {
            this.gateway.notifyTransferReceived(userId, {
              transactionId: payload.transactionId || 0,
              amount: payload.amount,
              fromEmail: payload.partnerEmail || 'usuario remitente',
              newBalance: payload.newBalance !== undefined ? payload.newBalance : 0,
              timestamp: payload.created_at || new Date(),
              status: payload.status,
            });
          }
        } else if (payload.type === 'DEPOSIT') {
          this.gateway.sendNotificationToUser(userId, 'deposit_received', {
            message: 'Depósito recibido exitosamente',
            type: 'DEPOSIT',
            status: payload.status,
            transactionId: payload.transactionId,
            amount: payload.amount,
            newBalance: payload.newBalance !== undefined ? payload.newBalance : 0,
            timestamp: payload.created_at || new Date(),
          });
        } else if (payload.type === 'WITHDRAW') {
          this.gateway.sendNotificationToUser(userId, 'withdraw_completed', {
            message: 'Retiro procesado exitosamente',
            type: 'WITHDRAW',
            status: payload.status,
            transactionId: payload.transactionId,
            amount: payload.amount,
            newBalance: payload.newBalance !== undefined ? payload.newBalance : 0,
            timestamp: payload.created_at || new Date(),
          });
        }
      } else {
        this.logger.warn(` Usuario ${userId} no está conectado - se enviará por correo`);
      }

      this.sendEmailNotificationAsync(userId, payload).catch(err =>
        this.logger.error(`Error email usuario ${userId}: ${err.message}`)
      );
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(` Error en notifyTransfer: ${errorMessage}`, error);
    }
  }

  async notifyRealtimeBalanceUpdate(userId: number, newBalance: number) {
    if (this.isConnected(userId)) {
      this.gateway.sendNotificationToUser(userId, 'balance.updated', {
        type: 'BALANCE_UPDATE',
        status: 'SUCCESS',
        balance: newBalance,
      });
    }
  }

  async sendEmailNotification(
    userId: number,
    payload: TransferNotificationPayload,
  ): Promise<void> {
    await this.sendEmailNotificationAsync(userId, payload);
  }

  private async sendEmailNotificationAsync(
    userId: number,
    payload: TransferNotificationPayload,
  ): Promise<void> {
    try {
      const user = await this.userService.findOne(userId);

      if (!user || !user.email) {
        this.logger.debug(`No se pudo enviar correo al usuario ${userId}: sin email registrado`);
        return;
      }

      let subject = '';
      let typeStr = '';

      switch (payload.type) {
        case 'TRANSFER':
          subject = 'Aviso de Transferencia - PayFlow';
          typeStr = payload.fromUserId === userId ? 'Transferencia Enviada' : 'Transferencia Recibida';
          break;
        case 'DEPOSIT':
          subject = 'Aviso de Depósito Recibido - PayFlow';
          typeStr = 'Depósito';
          break;
        case 'WITHDRAW':
          subject = 'Aviso de Retiro Exitoso - PayFlow';
          typeStr = 'Retiro';
          break;
        default:
          subject = 'Movimiento de Cuenta - PayFlow';
          typeStr = payload.type;
      }

      const emailSent = await this.mailService.sendTransactionEmail(user.email, subject, {
        transactionId: payload.transactionId || 0,
        type: typeStr,
        amount: payload.amount,
        status: payload.status,
        timestamp: payload.created_at || new Date(),
      });

      if (emailSent) {
        this.logger.log(`✉️ Correo enviado al usuario ${userId}`);
      } else {
        this.logger.warn(`⚠️ No se pudo enviar correo al usuario ${userId}`);
      }
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(` Error al enviar correo al usuario ${userId}: ${errorMessage}`);
    }
  }

  async findNotifications(userId: number, isAdmin: boolean, filters: GetNotificationsQueryDto) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 10;
    const query = this.buildQuery(userId, isAdmin, filters);
    const [data, total] = await query.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
    };
  }

  private buildQuery(userId: number, isAdmin: boolean, filters: GetNotificationsQueryDto) {
    let query: SelectQueryBuilder<Notification> = this.notificationRepository
      .createQueryBuilder('notification')
      .leftJoinAndSelect('notification.user', 'user');

    if (!isAdmin) {
      query = query.where('notification.user_id = :userId', { userId });
    }

    if (filters.type) {
      query = query.andWhere('notification.type = :type', { type: filters.type });
    }

    if (filters.status) {
      query = query.andWhere('notification.status = :status', { status: filters.status });
    }

    if (filters.read !== undefined) {
      query = query.andWhere('notification.read = :read', { read: filters.read });
    }

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 10;

    query = query.orderBy('notification.created_at', 'DESC');
    query = query.skip((page - 1) * limit).take(limit);

    return query;
  }

  async findNotificationById(notificationId: number) {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId },
      relations: ['user'],
    });

    if (!notification) {
      throw new NotFoundException(`Notificación ${notificationId} no encontrada`);
    }

    return notification;
  }

  async markAsRead(notificationId: number, userId: number, isAdmin: boolean, read: boolean) {
    const notification = await this.findNotificationById(notificationId);

    if (!isAdmin && notification.user.id !== userId) {
      throw new NotFoundException(`Notificación ${notificationId} no pertenece al usuario`);
    }

    notification.read = read;
    return this.notificationRepository.save(notification);
  }

  isConnected(userId: number): boolean {
    return this.connectedUsersService.isConnected(userId);
  }

  getSocketId(userId: number): string | undefined {
    return this.connectedUsersService.getSocketId(userId);
  }

  sendCustomNotification(userId: number, eventName: string, data: any) {
    if (this.isConnected(userId)) {
      this.gateway.sendNotificationToUser(userId, eventName, data);
    } else {
      this.logger.warn(` Usuario ${userId} no está conectado para recibir evento '${eventName}'`);
    }
  }
}
