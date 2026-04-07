import { describe, expect, test } from "bun:test";
import {
  APP_ERROR_CODES,
  appErrors,
  applicationError,
  createErrorResponse,
  createRpcError,
  internalError,
  invalidParams,
  invalidRequest,
  methodNotFound,
  parseError,
  RPC_ERROR_CODES,
} from "./errors";

describe("errors", () => {
  describe("RPC_ERROR_CODES", () => {
    test("has correct protocol error codes", () => {
      expect(RPC_ERROR_CODES.PARSE_ERROR).toBe(-32700);
      expect(RPC_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(RPC_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(RPC_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(RPC_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
      expect(RPC_ERROR_CODES.APPLICATION_ERROR).toBe(-32000);
    });
  });

  describe("createRpcError", () => {
    test("creates error without data", () => {
      const error = createRpcError(-32600, "Invalid request");
      expect(error).toEqual({
        code: -32600,
        message: "Invalid request",
      });
    });

    test("creates error with data", () => {
      const error = createRpcError(-32000, "App error", {
        code: "CUSTOM_ERROR",
        detail: "more info",
      });
      expect(error).toEqual({
        code: -32000,
        message: "App error",
        data: { code: "CUSTOM_ERROR", detail: "more info" },
      });
    });
  });

  describe("createErrorResponse", () => {
    test("creates response with numeric id", () => {
      const error = createRpcError(-32600, "Invalid");
      const response = createErrorResponse(error, 123);

      expect(response).toEqual({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid" },
        id: 123,
      });
    });

    test("creates response with string id", () => {
      const error = createRpcError(-32600, "Invalid");
      const response = createErrorResponse(error, "req-1");

      expect(response.id).toBe("req-1");
    });

    test("creates response with null id", () => {
      const error = createRpcError(-32700, "Parse error");
      const response = createErrorResponse(error, null);

      expect(response.id).toBeNull();
    });
  });

  describe("protocol error helpers", () => {
    test("parseError creates -32700 response", () => {
      const response = parseError();
      expect(response.error.code).toBe(-32700);
      expect(response.id).toBeNull();
    });

    test("invalidRequest creates -32600 response", () => {
      const response = invalidRequest(1, "missing field");
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain("missing field");
      expect(response.id).toBe(1);
    });

    test("methodNotFound creates -32601 response", () => {
      const response = methodNotFound("foo.bar", 42);
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain("foo.bar");
      expect(response.id).toBe(42);
    });

    test("invalidParams creates -32602 response", () => {
      const response = invalidParams(1, "expected string");
      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain("expected string");
    });

    test("internalError creates -32603 response", () => {
      const response = internalError(1);
      expect(response.error.code).toBe(-32603);
    });

    test("internalError with details", () => {
      const response = internalError(1, "database connection failed");
      expect(response.error.message).toContain("database connection failed");
    });
  });

  describe("applicationError", () => {
    test("creates -32000 response with string code", () => {
      const response = applicationError(1, "NOT_FOUND", "User not found");

      expect(response.error.code).toBe(-32000);
      expect(response.error.message).toBe("User not found");
      expect(response.error.data?.code).toBe("NOT_FOUND");
    });

    test("includes additional data", () => {
      const response = applicationError(
        1,
        "VALIDATION_ERROR",
        "Invalid email",
        {
          field: "email",
          value: "not-an-email",
        },
      );

      expect(response.error.data).toEqual({
        code: "VALIDATION_ERROR",
        field: "email",
        value: "not-an-email",
      });
    });
  });

  describe("appErrors helpers", () => {
    test("unauthorized", () => {
      const response = appErrors.unauthorized(1);
      expect(response.error.data?.code).toBe(APP_ERROR_CODES.UNAUTHORIZED);
    });

    test("forbidden", () => {
      const response = appErrors.forbidden(1);
      expect(response.error.data?.code).toBe(APP_ERROR_CODES.FORBIDDEN);
    });

    test("notFound", () => {
      const response = appErrors.notFound(1, "User");
      expect(response.error.data?.code).toBe(APP_ERROR_CODES.NOT_FOUND);
      expect(response.error.message).toContain("User");
    });

    test("conflict", () => {
      const response = appErrors.conflict(1, "Email already exists");
      expect(response.error.data?.code).toBe(APP_ERROR_CODES.CONFLICT);
    });

    test("rateLimited", () => {
      const response = appErrors.rateLimited(1);
      expect(response.error.data?.code).toBe(APP_ERROR_CODES.RATE_LIMITED);
    });

    test("validationError", () => {
      const response = appErrors.validationError(1, "Name too long");
      expect(response.error.data?.code).toBe(APP_ERROR_CODES.VALIDATION_ERROR);
    });
  });
});
