import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Every domain failure is thrown as an ApiError and serialized by `app.onError`. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
