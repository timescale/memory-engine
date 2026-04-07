/**
 * Tests for OAuth device flow state management.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  authorizeDevice,
  checkPollRateLimit,
  cleanupDeviceState,
  cleanupExpiredStates,
  createDeviceAuthorization,
  denyDevice,
  getActiveDeviceCount,
  getDeviceStateByDeviceCode,
  getDeviceStateByOAuthState,
  getDeviceStateByUserCode,
} from "./device-flow";

describe("device-flow", () => {
  // Clean up after each test
  afterEach(() => {
    cleanupExpiredStates();
  });

  describe("createDeviceAuthorization", () => {
    test("creates authorization with required fields", () => {
      const auth = createDeviceAuthorization("google");

      expect(auth.deviceCode).toBeDefined();
      expect(auth.deviceCode.length).toBeGreaterThan(20);

      expect(auth.userCode).toBeDefined();
      expect(auth.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      expect(auth.oauthState).toBeDefined();
      expect(auth.oauthState.length).toBeGreaterThan(10);

      expect(auth.expiresIn).toBe(900); // 15 minutes
      expect(auth.interval).toBe(5);
    });

    test("creates unique codes", () => {
      const auth1 = createDeviceAuthorization("google");
      const auth2 = createDeviceAuthorization("google");

      expect(auth1.deviceCode).not.toBe(auth2.deviceCode);
      expect(auth1.userCode).not.toBe(auth2.userCode);
      expect(auth1.oauthState).not.toBe(auth2.oauthState);
    });

    test("increments active device count", () => {
      const initialCount = getActiveDeviceCount();
      createDeviceAuthorization("google");
      expect(getActiveDeviceCount()).toBe(initialCount + 1);
    });
  });

  describe("getDeviceStateByUserCode", () => {
    test("finds state by user code", () => {
      const auth = createDeviceAuthorization("google");
      const state = getDeviceStateByUserCode(auth.userCode);

      expect(state).not.toBeNull();
      expect(state?.userCode).toBe(auth.userCode);
      expect(state?.provider).toBe("google");
    });

    test("normalizes user code (case insensitive, with/without hyphen)", () => {
      const auth = createDeviceAuthorization("google");

      // Original format
      expect(getDeviceStateByUserCode(auth.userCode)).not.toBeNull();

      // Lowercase
      expect(
        getDeviceStateByUserCode(auth.userCode.toLowerCase()),
      ).not.toBeNull();

      // Without hyphen
      expect(
        getDeviceStateByUserCode(auth.userCode.replace("-", "")),
      ).not.toBeNull();

      // Lowercase without hyphen
      expect(
        getDeviceStateByUserCode(auth.userCode.toLowerCase().replace("-", "")),
      ).not.toBeNull();
    });

    test("returns null for unknown code", () => {
      expect(getDeviceStateByUserCode("XXXX-XXXX")).toBeNull();
    });
  });

  describe("getDeviceStateByOAuthState", () => {
    test("finds state by OAuth state", () => {
      const auth = createDeviceAuthorization("google");
      const state = getDeviceStateByOAuthState(auth.oauthState);

      expect(state).not.toBeNull();
      expect(state?.oauthState).toBe(auth.oauthState);
    });

    test("returns null for unknown state", () => {
      expect(getDeviceStateByOAuthState("unknown-state")).toBeNull();
    });
  });

  describe("getDeviceStateByDeviceCode", () => {
    test("finds state by device code", () => {
      const auth = createDeviceAuthorization("google");
      const state = getDeviceStateByDeviceCode(auth.deviceCode);

      expect(state).not.toBeNull();
      expect(state?.deviceCode).toBe(auth.deviceCode);
    });

    test("returns null for unknown code", () => {
      expect(getDeviceStateByDeviceCode("unknown-code")).toBeNull();
    });
  });

  describe("checkPollRateLimit", () => {
    test("returns false on first poll", () => {
      const auth = createDeviceAuthorization("google");
      expect(checkPollRateLimit(auth.deviceCode)).toBe(false);
    });

    test("returns true when polling too fast", () => {
      const auth = createDeviceAuthorization("google");

      // First poll
      checkPollRateLimit(auth.deviceCode);

      // Immediate second poll should be rate limited
      expect(checkPollRateLimit(auth.deviceCode)).toBe(true);
    });

    test("returns false for unknown device code", () => {
      expect(checkPollRateLimit("unknown-code")).toBe(false);
    });
  });

  describe("authorizeDevice", () => {
    test("marks device as authorized", () => {
      const auth = createDeviceAuthorization("google");
      const identityId = "019d694f-79f6-7595-8faf-b70b01c11f98";

      const result = authorizeDevice(auth.deviceCode, identityId);
      expect(result).toBe(true);

      const state = getDeviceStateByDeviceCode(auth.deviceCode);
      expect(state?.authorizedIdentityId).toBe(identityId);
    });

    test("returns false for unknown device code", () => {
      const result = authorizeDevice(
        "unknown-code",
        "019d694f-79f6-7595-8faf-b70b01c11f98",
      );
      expect(result).toBe(false);
    });
  });

  describe("denyDevice", () => {
    test("marks device as denied", () => {
      const auth = createDeviceAuthorization("google");

      const result = denyDevice(auth.deviceCode);
      expect(result).toBe(true);

      const state = getDeviceStateByDeviceCode(auth.deviceCode);
      expect(state?.denied).toBe(true);
    });

    test("returns false for unknown device code", () => {
      const result = denyDevice("unknown-code");
      expect(result).toBe(false);
    });
  });

  describe("cleanupDeviceState", () => {
    test("removes device state and all indexes", () => {
      const auth = createDeviceAuthorization("google");

      cleanupDeviceState(auth.deviceCode);

      expect(getDeviceStateByDeviceCode(auth.deviceCode)).toBeNull();
      expect(getDeviceStateByUserCode(auth.userCode)).toBeNull();
      expect(getDeviceStateByOAuthState(auth.oauthState)).toBeNull();
    });

    test("handles unknown device code gracefully", () => {
      // Should not throw
      cleanupDeviceState("unknown-code");
    });
  });

  describe("cleanupExpiredStates", () => {
    test("removes expired states", async () => {
      // Create a state
      const auth = createDeviceAuthorization("google");
      const initialCount = getActiveDeviceCount();

      // Manually expire it by modifying the state
      const state = getDeviceStateByDeviceCode(auth.deviceCode);
      if (state) {
        state.expiresAt = new Date(Date.now() - 1000); // Expired 1 second ago
      }

      // Cleanup
      const cleaned = cleanupExpiredStates();
      expect(cleaned).toBeGreaterThanOrEqual(1);

      // State should be gone
      expect(getDeviceStateByDeviceCode(auth.deviceCode)).toBeNull();
    });
  });

  describe("state expiration", () => {
    test("expired state returns null on lookup", () => {
      const auth = createDeviceAuthorization("google");

      // Manually expire it
      const state = getDeviceStateByDeviceCode(auth.deviceCode);
      if (state) {
        state.expiresAt = new Date(Date.now() - 1000);
      }

      // Lookup should return null and clean up
      expect(getDeviceStateByDeviceCode(auth.deviceCode)).toBeNull();
      expect(getDeviceStateByUserCode(auth.userCode)).toBeNull();
      expect(getDeviceStateByOAuthState(auth.oauthState)).toBeNull();
    });
  });
});
