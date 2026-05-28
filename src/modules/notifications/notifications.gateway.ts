import {WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage,} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ConnectedUsersService } from './connected-users.service';

@WebSocketGateway({
  cors: {
    origin: '*', 
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private cleanupInterval?: NodeJS.Timeout;

  constructor(
    @Inject(ConnectedUsersService)
    private readonly connectedUsersService: ConnectedUsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.cleanupInterval = setInterval(() => {
      this.checkExpiredTokens();
    }, 60000); // 60 seconds
    this.logger.log('⏰ Servidor WebSocket inicializado con chequeo de expiración JWT (cada 60 segundos)');
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  private checkExpiredTokens() {
    try {
      this.logger.debug('⏰ Ejecutando chequeo proactivo de tokens JWT expirados...');
      if (!this.server) {
        this.logger.warn('Servidor WebSocket aún no disponible para el chequeo de expiración');
        return;
      }

      const namespace: any = typeof (this.server as any).of === 'function'
        ? (this.server as any).of('/notifications')
        : this.server;
      const socketsCollection = namespace?.sockets;
      const now = Math.floor(Date.now() / 1000);
      let disconnectCount = 0;

      const sockets = socketsCollection instanceof Map
        ? Array.from(socketsCollection.values())
        : socketsCollection?.sockets instanceof Map
          ? Array.from(socketsCollection.sockets.values())
          : [];

      for (const socket of sockets) {
        const user = socket.data?.user;
        if (user && user.exp) {
          if (now >= user.exp) {
            this.logger.warn(
              `🔒 Sesión expirada para el usuario ${user.email || 'desconocido'} (ID: ${user.sub || socket.data.userId}). Desconectando socket proactivamente: ${socket.id}`,
            );
            socket.emit('session_expired', { message: 'Tu sesión ha expirado. Por favor, inicia sesión nuevamente.' });
            socket.disconnect(true);
            disconnectCount++;
          }
        }
      }

      if (disconnectCount > 0) {
        this.logger.log(`⏰ Se desconectaron proactivamente ${disconnectCount} sockets con tokens JWT expirados.`);
      }
    } catch (error: any) {
      this.logger.error('Error al realizar el chequeo de tokens expirados', error);
    }
  }

  handleConnection(client: Socket) {
    try {
      this.logger.debug('SOCKET CONNECTED');
      this.logger.debug('handshake.auth: ' + JSON.stringify(client.handshake.auth));

      const token = this.extractTokenFromSocket(client);
      const tokenSource = this.getTokenSource(client);
      this.logger.debug(`token source: ${tokenSource}`);

      if (!token) {
        this.logger.warn(`Conexión rechazada por falta de token. Socket: ${client.id}`);
        client.emit('connection_error', { message: 'Auth token missing' });
        client.disconnect(true);
        return;
      }

      const jwtSecret = this.configService.get<string>('JWT_SECRET');
      const decoded = this.jwtService.verify(token, { secret: jwtSecret });
      const userId = Number(decoded.sub ?? decoded.id);
      const email = decoded.email as string | undefined;

      if (!userId || Number.isNaN(userId)) {
        this.logger.warn(`Token JWT inválido o sin userId. Socket: ${client.id}`);
        client.emit('connection_error', { message: 'Invalid authentication data' });
        client.disconnect(true);
        return;
      }

      client.data.user = decoded;
      client.data.userId = userId;
      client.data.email = email;

      this.connectedUsersService.registerConnection(
        userId,
        client.id,
        email || 'unknown',
      );

      this.logger.log(`REGISTERED USER: ${userId} socket: ${client.id}`);

      client.emit('connection_established', {
        ok: true,
        userId,
        socketId: client.id,
      });

      this.logger.log(
        `🔌 Usuario conectado: ${email || 'desconocido'} (${userId}) - Socket: ${client.id}`,
      );
    } catch (error: any) {
      this.logger.error('Error en handleConnection', error);
      client.emit('connection_error', { message: 'Auth error' });
      client.disconnect(true);
    }
  }

  private extractTokenFromSocket(client: Socket): string | undefined {
    const authToken =
      client.handshake.auth?.token ||
      client.handshake.query?.token ||
      this.getBearerTokenFromHeaders(client);

    return typeof authToken === 'string' ? authToken : undefined;
  }

  private getTokenSource(client: Socket): string {
    if (client.handshake.auth?.token) {
      return 'handshake.auth';
    }
    if (client.handshake.query?.token) {
      return 'handshake.query';
    }
    if (this.getBearerTokenFromHeaders(client)) {
      return 'authorization_header';
    }
    return 'none';
  }

  private getBearerTokenFromHeaders(client: Socket): string | undefined {
    const authHeader = client.handshake.headers?.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      return undefined;
    }

    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }

    return undefined;
  }

  handleDisconnect(client: Socket) {
    try {
      const userId = client.data.userId;
      const email = client.data.email;

      const wasConnected =
        this.connectedUsersService.disconnectBySocket(client.id);

      if (wasConnected) {
        client.broadcast.emit('user_disconnected', {
          userId,
          email,
          disconnectedAt: new Date(),
          totalConnected: this.connectedUsersService.getTotalConnected(),
        });

        this.logger.log(
          ` Desconexión - Usuario: ${email} (ID: ${userId}), Socket: ${client.id}`,
        );
      } else {
        this.logger.warn(
          ` Intento de desconectar usuario no registrado. Socket: ${client.id}`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(
        ` Error en handleDisconnect: ${errorMessage}`,
        error,
      );
    }
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket): { event: string; data: string } {
    const userId = client.data.userId;
    this.logger.debug(`Ping recibido de usuario ${userId}`);
    return { event: 'pong', data: `pong-${new Date().getTime()}` };
  }

  @SubscribeMessage('get_connection_status')
  handleGetConnectionStatus(client: Socket) {
    const userId = client.data.userId;
    const connectionInfo =
      this.connectedUsersService.getConnectionInfo(userId);

    return {
      event: 'connection_status',
      data: {
        userId,
        socketId: client.id,
        isConnected: true,
        connectedAt: connectionInfo?.connectedAt || new Date(),
      },
    };
  }
  
  notifyTransferSent(
    fromUserId: number,
    transactionData: {
      transactionId: number;
      amount: number;
      toEmail: string;
      newBalance: number;
      timestamp: Date;
      status: string;
    },
  ) {
    const socketIds = this.connectedUsersService.getSocketIds(fromUserId);

    if (socketIds.length > 0) {
      for (const socketId of socketIds) {
        this.server.to(socketId).emit('transfer_sent', {
          message: 'Transferencia enviada exitosamente',
          type: 'TRANSFER',
          status: transactionData.status,
          transactionId: transactionData.transactionId,
          amount: transactionData.amount,
          toEmail: transactionData.toEmail,
          newBalance: transactionData.newBalance,
          timestamp: transactionData.timestamp,
        });

        this.logger.log(
          `📤 Notificación enviada al usuario ${fromUserId} a través de socket ${socketId}: transferencia ID ${transactionData.transactionId}`,
        );
      }
    } else {
      this.logger.warn(
        ` Usuario ${fromUserId} no está conectado para recibir notificación de transferencia`,
      );
    }
  }

  notifyTransferReceived(
    toUserId: number,
    transactionData: {
      transactionId: number;
      amount: number;
      fromEmail: string;
      newBalance: number;
      timestamp: Date;
      status: string;
    },
  ) {
    const socketIds = this.connectedUsersService.getSocketIds(toUserId);

    if (socketIds.length > 0) {
      for (const socketId of socketIds) {
        this.server.to(socketId).emit('transfer_received', {
          message: '¡Has recibido una transferencia!',
          type: 'TRANSFER',
          status: transactionData.status,
          transactionId: transactionData.transactionId,
          amount: transactionData.amount,
          fromEmail: transactionData.fromEmail,
          newBalance: transactionData.newBalance,
          timestamp: transactionData.timestamp,
        });

        this.logger.log(
          `Notificación enviada al usuario ${toUserId} a través de socket ${socketId}: transferencia recibida ID ${transactionData.transactionId}`,
        );
      }
    } else {
      this.logger.warn(
        ` Usuario ${toUserId} no está conectado para recibir notificación de transferencia`,
      );
    }
  }

  notifyTransfer(payload: {
    fromUserId: number;
    toUserId: number;
    amount: number;
    transactionId: number;
    newBalanceFrom: number;
    newBalanceTo: number;
    timestamp: Date;
    status: string;
  }) {
    this.notifyTransferSent(payload.fromUserId, {
      transactionId: payload.transactionId,
      amount: payload.amount,
      toEmail: 'usuario',
      newBalance: payload.newBalanceFrom,
      timestamp: payload.timestamp,
      status: payload.status,
    });

    this.notifyTransferReceived(payload.toUserId, {
      transactionId: payload.transactionId,
      amount: payload.amount,
      fromEmail: 'usuario',
      newBalance: payload.newBalanceTo,
      timestamp: payload.timestamp,
      status: payload.status,
    });
  }

  sendNotificationToUser(
    userId: number,
    eventName: string,
    data: any,
  ) {
    const socketIds = this.connectedUsersService.getSocketIds(userId);

    this.logger.debug(`SEND WS EVENT to ${socketIds.length} sockets: ` + JSON.stringify({ userId, socketIds, eventName }));

    if (socketIds.length > 0) {
      for (const socketId of socketIds) {
        this.server.to(socketId).emit(eventName, data);
        this.logger.log(`EVENT SENT TO SOCKET: ${socketId} for user ${userId}`);
      }
    } else {
      this.logger.warn(`USER NOT CONNECTED: ${userId}`);
    }
  }

  isUserConnected(userId: number): boolean {
    return this.connectedUsersService.isConnected(userId);
  }
}

