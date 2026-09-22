import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EmailService, EMAIL_PROVIDER } from './email.service';
import { MockEmailProvider, UnavailableEmailProvider } from './email-provider.interface';
import { isProduction } from '../../common/provider-mode';
import { BrevoEmailProvider } from './brevo-email-provider';

const logger = new Logger('EmailModule');

@Module({
  imports: [ConfigModule],
  providers: [
    EmailService,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('BREVO_API_KEY')) {
          return new BrevoEmailProvider(config);
        }
        if (isProduction(config.get<string>('NODE_ENV'))) {
          logger.error('BREVO_API_KEY is not set — emails are NOT being sent (production never uses the logging mock).');
          return new UnavailableEmailProvider();
        }
        logger.warn(
          'BREVO_API_KEY not set — falling back to MockEmailProvider. ' +
            'Emails will be logged, not actually sent.',
        );
        return new MockEmailProvider();
      },
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
