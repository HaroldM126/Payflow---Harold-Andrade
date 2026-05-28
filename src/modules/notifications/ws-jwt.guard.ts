import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';


@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  
canActivate(context: ExecutionContext): boolean {
  const client: Socket =
    context.switchToWs().getClient();

  try {
    this.logger.debug('HANDSHAKE AUTH');
    this.logger.debug('handshake.auth: ' + JSON.stringify(client.handshake.auth));

    const token =
      client.handshake.auth?.token ||
      client.handshake.query?.token ||
      this.extractTokenFromSocket(client);

    this.logger.debug('TOKEN RECIBIDO: ' + token);

    if (!token) {
      this.logger.warn('SIN TOKEN');

      client.disconnect(true);
      return false;
    }

    const jwtSecret =
      this.configService.get<string>(
        'JWT_SECRET',
      );

    const decoded =
      this.jwtService.verify(token, {
        secret: jwtSecret,
      });

    this.logger.debug('JWT DECODED: ' + JSON.stringify(decoded));

    client.data.user = decoded;
    client.data.userId = decoded.sub ?? decoded.id;
    client.data.email = decoded.email;

    this.logger.debug('USER ID: ' + client.data.userId);

    return true;
  } catch (error) {
    this.logger.error('JWT ERROR: ' + (error instanceof Error ? error.message : String(error)));

    client.disconnect(true);
    return false;
  }
}

  
  private extractTokenFromSocket(client: Socket): string | undefined {
    const authHeader = client.handshake.headers.authorization;

    if (!authHeader) {
      return undefined;
    }

    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }

    return undefined;
  }
}
