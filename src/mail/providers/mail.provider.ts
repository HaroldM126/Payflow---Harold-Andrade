import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

// Factoría que crea y configura el Transporter de Nodemailer usando ConfigService
export const MailProvider = {
  provide: 'MAIL_TRANSPORTER', // Token de inyección string requerido
  useFactory: (configService: ConfigService) => {
    return nodemailer.createTransport({
      host: configService.get<string>('MAIL_HOST'),
      port: configService.get<number>('MAIL_PORT'),
      secure: configService.get<number>('MAIL_PORT') === 465, // true para puerto 465, false para otros
      auth: {
        user: configService.get<string>('MAIL_USER'),
        pass: configService.get<string>('MAIL_PASSWORD'),
      },
    } as any);
  },
  inject: [ConfigService],
};
