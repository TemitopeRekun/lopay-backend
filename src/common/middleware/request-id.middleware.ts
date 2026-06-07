import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const REQUEST_ID_HEADER = 'X-Request-ID';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers[REQUEST_ID_HEADER.toLowerCase()] as string) || randomUUID();
    req.headers[REQUEST_ID_HEADER.toLowerCase()] = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
