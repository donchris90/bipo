import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

// The stock response body is `ThrottlerException: Too Many Requests`, which is
// exactly what the mobile app would show in an alert (screens display
// error.response.data.message). This swaps in a message a person can act on.
// The status (429) and the Retry-After header the guard sets are unchanged.
export const THROTTLED_MESSAGE = 'Too many requests. Please wait a moment and try again.';

@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  catch(_exception: ThrottlerException, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(429).json({ statusCode: 429, message: THROTTLED_MESSAGE });
  }
}
