// =============================================================================
// GENHUB - API Response Helpers
// Standardized JSON responses for Next.js API routes
// =============================================================================

import { NextResponse } from "next/server";

interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
}

// Standard success response
export function apiSuccess<T>(data: T, message?: string, status: number = 200): NextResponse {
  const body: SuccessResponse<T> = {
    success: true,
    data,
  };
  if (message) body.message = message;
  return NextResponse.json(body, { status });
}

// Standard error response
export function apiError(error: string, status: number = 400, code?: string): NextResponse {
  const body: ErrorResponse = {
    success: false,
    error,
  };
  if (code) body.code = code;
  return NextResponse.json(body, { status });
}

// Common error responses
export const api = {
  success: apiSuccess,
  error: apiError,
  unauthorized: (msg = "Authentication required") =>
    apiError(msg, 401, "UNAUTHORIZED"),
  forbidden: (msg = "Insufficient permissions") =>
    apiError(msg, 403, "FORBIDDEN"),
  notFound: (msg = "Resource not found") =>
    apiError(msg, 404, "NOT_FOUND"),
  validation: (msg: string) =>
    apiError(msg, 422, "VALIDATION_ERROR"),
  rateLimited: (msg = "Too many requests") =>
    apiError(msg, 429, "RATE_LIMITED"),
  internal: (msg = "Internal server error") =>
    apiError(msg, 500, "INTERNAL_ERROR"),
};
