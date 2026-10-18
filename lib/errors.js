'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);
const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

module.exports = { HttpError, bad, forbidden, notFound, conflict };
