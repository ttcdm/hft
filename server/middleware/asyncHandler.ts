import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * P1.4 (N-6): Express 4 does not catch a rejected promise from an async route, so a throw left the request hanging with no answer.
 * Every async route is wrapped in this: a rejection goes to `next(err)`, and the central errorHandler answers it (500 with the message).
 */
export function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  fn: (req: Req, res: Res, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req as Req, res as Res, next))
      .catch(next); // once headers are out, Express's default handler closes the connection
  };
}
