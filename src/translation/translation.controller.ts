import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TranslationService } from './translation.service';

/**
 * Public because authentication/onboarding screens also need automatic
 * translation before a user has a JWT. Keep payload limits in the service and
 * protect the route with the app's global throttling/rate limiting.
 */
@Controller('api/v1/translation')
export class TranslationController {
  constructor(private readonly translation: TranslationService) {}

  @Post('batch')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  batch(
    @Body('targetLanguage') targetLanguage: string,
    @Body('texts') texts: string[],
  ) {
    return this.translation.batch(targetLanguage, texts);
  }
}
