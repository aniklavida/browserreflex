/**
 * Public surface of the local REST API.
 *
 * Status: **implemented and tested**
 */

export {
  startApiServer,
  createRequestListener,
  createApiRouter,
  defaultAllowedOrigins,
  API_BIND_HOST,
  DEFAULT_API_PORT,
  type ApiServerOptions,
  type ApiServerHandle,
  type RequestListenerOptions,
} from './server.js';
export {
  isLocalRequest,
  isLocalAddress,
  isLocalHostName,
  isCorsAllowed,
  rejectForbidden,
} from './guard.js';
export {
  maskSetting,
  maskSettingValue,
  isCredentialName,
  valueLooksLikeSecret,
  refuseSettingWrite,
  MASKED_PLACEHOLDER,
  type MaskedSetting,
} from './settings-mask.js';
export { createStaticUiHandler, resolveWithinRoot, type StaticUiOptions } from './static-ui.js';
export { applyReviewAnswer, describeReviewError, type ReviewAnswerInput } from './review-answer.js';
export { buildStats, type ApiStats } from './stats.js';
export { ApiRouter, type RouteHandler, type RouteParams } from './router.js';
export {
  jsonResponse,
  errorResponse,
  readJsonBody,
  parseQuery,
  errorStatus,
  HttpError,
  MAX_BODY_BYTES,
} from './http.js';
