import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

function errorMessage(exception: unknown) {
  if (!(exception instanceof Error)) return 'Internal error';
  const cause = (exception as Error & { cause?: unknown }).cause;
  const nested =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : '';
  const raw =
    nested && !exception.message.includes(nested)
      ? `${exception.message} (${nested})`
      : exception.message;

  // Hide noisy SQL dumps; surface a clear connectivity hint instead.
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT|connect ECONN/i.test(raw)) {
    return 'Cannot reach the database. Check your internet connection and DATABASE_URL (prefer the Supabase pooler host).';
  }
  if (/Failed query:/i.test(raw) && /ENOTFOUND|getaddrinfo/i.test(raw)) {
    return 'Cannot reach the database. Check your internet connection and DATABASE_URL (prefer the Supabase pooler host).';
  }
  if (/Failed query:/i.test(raw)) {
    return 'Database query failed. Please try again.';
  }
  return raw;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(typeof body === 'string' ? { error: body, message: body } : body);
      return;
    }

    const message = errorMessage(exception);
    const status =
      /invalid|missing|required|unknown/i.test(message)
        ? HttpStatus.BAD_REQUEST
        : /not found/i.test(message)
          ? HttpStatus.NOT_FOUND
          : HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({ error: message, message });
  }
}
