import { type Context, SpanStatusCode } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { APIError } from "better-auth/api";
import { APIError as BetterCallAPIError } from "better-call";
import {
  isExpectedOAuthError,
  oauthErrorTelemetryAttributes,
} from "./oauth-errors";

const TOKEN_ROUTE = "/oauth2/token";

/**
 * Install with Logfire's additionalSpanProcessors. Better Auth 1.6.20 reports
 * protocol rejections via recordException(error), setStatus(ERROR), end(). There
 * is no SDK hook to filter an exception before recording it, and onEnd is too
 * late (an earlier processor may already have exported it).
 *
 * Adapt only the public methods of matching live spans during onStart. No
 * prototype/global patch, ReadableSpan mutation, extra signal, or payload copy.
 * Keep the SDK's initial UNSET status by consuming just the next matching ERROR;
 * UNSET cannot reset an existing ERROR through the public OTel API.
 */
export class OAuthClientErrorSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    try {
      if (
        span.instrumentationScope.name !== "better-auth" ||
        span.attributes["http.route"] !== TOKEN_ROUTE ||
        (span.name !== `handler ${TOKEN_ROUTE}` &&
          span.name !== `POST ${TOKEN_ROUTE}`)
      )
        return;
      this.adapt(span);
    } catch {
      // Instrumentation setup must never prevent authentication or server boot.
    }
  }

  private adapt(span: Span): void {
    const recordException = span.recordException;
    const setStatus = span.setStatus;
    let pendingMessage: string | undefined;
    let classified = false;
    let unexpected = false;

    const invalidate = () => {
      pendingMessage = undefined;
      unexpected = true;
      if (classified) {
        // Preserve the OAuth outcome, but never label a later real failure as
        // expected/info. OTel has no public removeAttribute API.
        try {
          span.setAttribute("error.expected", false);
        } catch {
          /* fail open */
        }
        try {
          span.setAttribute("logfire.level_num", 17);
        } catch {
          /* fail open */
        }
      }
    };

    const adaptedRecordException: Span["recordException"] = (
      exception,
      time,
    ) => {
      try {
        pendingMessage = undefined;
        if (
          !unexpected &&
          span.isRecording() &&
          span.status.code === SpanStatusCode.UNSET &&
          !span.events.some((event) => event.name === "exception") &&
          // Provider credential validation throws the better-call base class;
          // token grant handlers throw Better Auth's subclass. Accept only
          // those concrete dependency identities, never APIError-shaped values.
          (exception instanceof APIError ||
            exception instanceof BetterCallAPIError) &&
          isExpectedOAuthError(exception.statusCode, exception.body?.error)
        ) {
          classified = true;
          span.setAttributes({
            ...oauthErrorTelemetryAttributes(
              exception.statusCode,
              exception.body?.error,
              exception.body?.error_description,
            ),
            "http.response.status_code": exception.statusCode,
            "logfire.level_num": 9,
          });
          pendingMessage = String(exception.message);
          return;
        }
        invalidate();
      } catch {
        // Fail conservative: preserve the original exception if classification
        // or attribute instrumentation breaks.
        invalidate();
      }
      recordException.call(span, exception, time);
    };
    const adaptedSetStatus: Span["setStatus"] = (status) => {
      try {
        const expectedMessage = pendingMessage;
        pendingMessage = undefined; // single-use, never a sticky suppression flag
        if (
          expectedMessage !== undefined &&
          status.code === SpanStatusCode.ERROR &&
          status.message === expectedMessage
        )
          return span;
        if (status.code === SpanStatusCode.ERROR) invalidate();
      } catch {
        pendingMessage = undefined;
        unexpected = true;
      }
      return setStatus.call(span, status);
    };

    try {
      span.recordException = adaptedRecordException;
      span.setStatus = adaptedSetStatus;
    } catch {
      // Frozen/otherwise non-writable spans simply keep upstream behavior. Even
      // partial installation must not accidentally suppress their exceptions.
      unexpected = true;
      try {
        span.recordException = recordException;
      } catch {
        /* fail open */
      }
      try {
        span.setStatus = setStatus;
      } catch {
        /* fail open */
      }
    }
  }

  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
