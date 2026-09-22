import { ThrottlerException } from '@nestjs/throttler';
import { THROTTLED_MESSAGE, ThrottlerExceptionFilter } from './throttler-exception.filter';

describe('ThrottlerExceptionFilter', () => {
  it('answers 429 with a human-readable message', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host: any = { switchToHttp: () => ({ getResponse: () => ({ status }) }) };

    new ThrottlerExceptionFilter().catch(new ThrottlerException(), host);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({ statusCode: 429, message: THROTTLED_MESSAGE });
  });
});
