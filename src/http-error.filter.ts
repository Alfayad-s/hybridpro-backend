import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

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

    const message = exception instanceof Error ? exception.message : 'Internal error';
    const status =
      /invalid|missing|required|unknown/i.test(message)
        ? HttpStatus.BAD_REQUEST
        : /not found/i.test(message)
          ? HttpStatus.NOT_FOUND
          : HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({ error: message, message });
  }
}
