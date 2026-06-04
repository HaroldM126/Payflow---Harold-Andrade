import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BANK_OPERATION_EVENT } from '../../events/bank-operation.event';
import type { BankOperationEvent } from '../../events/bank-operation.event';
import { NotificationsService } from './notifications.service';
import { OperationType } from '../../events/operation-type.enum';
import { OperationStatus } from '../../events/operation-status.enum';

@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  @OnEvent(BANK_OPERATION_EVENT, { async: true })
  async handleBankOperationEvent(event: BankOperationEvent) {
    try {
      this.logger.log(
        `🔔 Recibido BANK_OPERATION_EVENT: ${event.operationType} - ${event.operationStatus} para el usuario ${event.userId}`,
      );

      const isSuccess = event.operationStatus === OperationStatus.SUCCESS;

      // 1. Persistir notificación para el iniciador
      const savedNotification =
        await this.notificationsService.createFromEvent(event);
      this.logger.log(
        `💾 Notificación persistida en BD para el iniciador ID: ${event.userId} (ID Notificación: ${savedNotification.id})`,
      );

      // Si es un TRANSFER y es exitoso, persistimos una notificación para el receptor también
      if (
        event.operationType === OperationType.TRANSFER &&
        isSuccess &&
        event.toUserId
      ) {
        const receiverEvent: BankOperationEvent = {
          ...event,
          userId: event.toUserId,
          message: `Has recibido una transferencia de ${event.amount} de ${event.senderEmail || 'un usuario'}.`,
        };
        const savedReceiverNotification =
          await this.notificationsService.createFromEvent(receiverEvent);
        this.logger.log(
          `💾 Notificación persistida en BD para el receptor ID: ${event.toUserId} (ID Notificación: ${savedReceiverNotification.id})`,
        );
      }

      // Si la operación falló, guardamos en BD y terminamos (no enviamos WebSockets ni correos de éxito)
      if (!isSuccess) {
        this.logger.warn(`
          ⚠️ Operación fallida. No se envían notificaciones en tiempo real ni correos.`);
        return;
      }

      // 2. Despachar notificaciones en tiempo real (WebSockets) y correos electrónicos (Mail)
      if (event.operationType === OperationType.TRANSFER) {
        // Notificación para el Emisor
        await this.notificationsService.notifyTransfer(event.userId, {
          transactionId: event.transactionId,
          type: 'TRANSFER',
          amount: event.amount,
          fromAccountId: event.fromAccountId,
          toAccountId: event.toAccountId,
          fromUserId: event.userId,
          toUserId: event.toUserId,
          status: event.operationStatus,
          created_at: new Date(event.occurredAt),
          partnerEmail: event.receiverEmail || 'usuario destinatario',
          newBalance: event.senderBalance,
        });

        // Actualizar saldo del Emisor
        if (event.senderBalance !== undefined) {
          await this.notificationsService.notifyRealtimeBalanceUpdate(
            event.userId,
            event.senderBalance,
          );
        }

        // Notificación para el Receptor
        if (event.toUserId) {
          await this.notificationsService.notifyTransfer(event.toUserId, {
            transactionId: event.transactionId,
            type: 'TRANSFER',
            amount: event.amount,
            fromAccountId: event.fromAccountId,
            toAccountId: event.toAccountId,
            fromUserId: event.userId,
            toUserId: event.toUserId,
            status: event.operationStatus,
            created_at: new Date(event.occurredAt),
            partnerEmail: event.senderEmail || 'usuario remitente',
            newBalance: event.receiverBalance,
          });

          // Actualizar saldo del Receptor
          if (event.receiverBalance !== undefined) {
            await this.notificationsService.notifyRealtimeBalanceUpdate(
              event.toUserId,
              event.receiverBalance,
            );
          }
        }
      } else if (event.operationType === OperationType.DEPOSIT) {
        await this.notificationsService.notifyTransfer(event.userId, {
          transactionId: event.transactionId,
          type: 'DEPOSIT',
          amount: event.amount,
          toAccountId: event.toAccountId,
          toUserId: event.userId,
          status: event.operationStatus,
          created_at: new Date(event.occurredAt),
          newBalance: event.senderBalance,
        });

        if (event.senderBalance !== undefined) {
          await this.notificationsService.notifyRealtimeBalanceUpdate(
            event.userId,
            event.senderBalance,
          );
        }
      } else if (event.operationType === OperationType.WITHDRAW) {
        await this.notificationsService.notifyTransfer(event.userId, {
          transactionId: event.transactionId,
          type: 'WITHDRAW',
          amount: event.amount,
          fromAccountId: event.fromAccountId,
          fromUserId: event.userId,
          status: event.operationStatus,
          created_at: new Date(event.occurredAt),
          newBalance: event.senderBalance,
        });

        if (event.senderBalance !== undefined) {
          await this.notificationsService.notifyRealtimeBalanceUpdate(
            event.userId,
            event.senderBalance,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      const stack = error instanceof Error ? error.stack : '';
      this.logger.error(
        `❌ Fallo al procesar el listener de operaciones bancarias: ${message}`,
        stack,
      );
    }
  }
}
