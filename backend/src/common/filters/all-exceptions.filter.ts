import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

// Keeps Nest's normal responses exactly as they were (a 404 is still a 404, a 500
// is still "Internal server error"), but writes every SERVER error to the log with
// the request that caused it, on one line:
//
//   500 POST /api/v1/rooms/abc/join  TypeError: Cannot read properties of ...
//   ...followed by Nest's usual stack trace
//
// Nest already logs the stack, but without saying which request it was — which is
// what you need to find a bug from "the party says internal server error".
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ServerError');

  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500 && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest();
      const message = exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
      // One summary line naming the request. (Nest's own handler, called below, prints the stack.)
      this.logger.error(`${status} ${req?.method} ${req?.originalUrl ?? req?.url}  ${message}`);
    }
    super.catch(exception, host);
  }
}
