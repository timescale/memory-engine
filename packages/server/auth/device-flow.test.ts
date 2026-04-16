/**
 * Tests for OAuth device flow state management.
 *
 * Uses an in-memory mock of the device auth database operations.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AccountsDB,
  CreateDeviceAuthParams,
  DeviceAuthorization,
} from "@memory.build/accounts";
import {
  authorizeDevice,
  checkPollRateLimit,
  cleanupDeviceState,
  cleanupExpiredStates,
  createDeviceAuthorization,
  denyDevice,
  getDeviceStateByDeviceCode,
  getDeviceStateByOAuthState,
  getDeviceStateByUserCode,
} from "./device-flow";

/**
 * Create a mock AccountsDB with in-memory device auth storage.
 * Only implements the device auth methods needed for testing.
 */
function createMockDb(): AccountsDB {
  const store = new Map<string, DeviceAuthorization>();
  const userCodeIndex = new Map<string, string>();
  const oauthStateIndex = new Map<string, string>();

  return {
    // Device auth operations
    create: async (params: CreateDeviceAuthParams) => {
      const auth: DeviceAuthorization = {
        deviceCode: params.deviceCode,
        userCode: params.userCode,
        provider: params.provider,
        oauthState: params.oauthState,
        expiresAt: params.expiresAt,
        lastPoll: null,
        identityId: null,
        denied: false,
        createdAt: new Date(),
      };
      store.set(params.deviceCode, auth);
      userCodeIndex.set(params.userCode, params.deviceCode);
      oauthStateIndex.set(params.oauthState, params.deviceCode);
      return auth;
    },

    getByDeviceCode: async (deviceCode: string) => {
      const auth = store.get(deviceCode);
      if (!auth || new Date() > auth.expiresAt) {
        return null;
      }
      return auth;
    },

    getByUserCode: async (userCode: string) => {
      // Normalize: uppercase, remove hyphen, reconstruct XXXX-XXXX
      const normalized = userCode.toUpperCase().replace(/-/g, "");
      const formatted = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
      const deviceCode = userCodeIndex.get(formatted);
      if (!deviceCode) return null;
      const auth = store.get(deviceCode);
      if (!auth || new Date() > auth.expiresAt) {
        return null;
      }
      return auth;
    },

    getByOAuthState: async (oauthState: string) => {
      const deviceCode = oauthStateIndex.get(oauthState);
      if (!deviceCode) return null;
      const auth = store.get(deviceCode);
      if (!auth || new Date() > auth.expiresAt) {
        return null;
      }
      return auth;
    },

    updateLastPoll: async (deviceCode: string) => {
      const auth = store.get(deviceCode);
      if (!auth || new Date() > auth.expiresAt) {
        return null;
      }
      const previousPoll = auth.lastPoll;
      auth.lastPoll = new Date();
      if (!previousPoll) {
        return null;
      }
      return Date.now() - previousPoll.getTime();
    },

    authorize: async (deviceCode: string, identityId: string) => {
      const auth = store.get(deviceCode);
      if (
        !auth ||
        new Date() > auth.expiresAt ||
        auth.identityId !== null ||
        auth.denied
      ) {
        return false;
      }
      auth.identityId = identityId;
      return true;
    },

    deny: async (deviceCode: string) => {
      const auth = store.get(deviceCode);
      if (!auth || new Date() > auth.expiresAt || auth.identityId !== null) {
        return false;
      }
      auth.denied = true;
      return true;
    },

    delete: async (deviceCode: string) => {
      const auth = store.get(deviceCode);
      if (!auth) return false;
      userCodeIndex.delete(auth.userCode);
      oauthStateIndex.delete(auth.oauthState);
      store.delete(deviceCode);
      return true;
    },

    deleteExpired: async () => {
      const now = new Date();
      let count = 0;
      for (const [deviceCode, auth] of store) {
        if (now > auth.expiresAt) {
          userCodeIndex.delete(auth.userCode);
          oauthStateIndex.delete(auth.oauthState);
          store.delete(deviceCode);
          count++;
        }
      }
      return count;
    },

    // Expose store for testing (to manually expire entries)
    _store: store,
  } as unknown as AccountsDB;
}

describe("device-flow", () => {
  let db: AccountsDB;

  beforeEach(() => {
    db = createMockDb();
  });

  describe("createDeviceAuthorization", () => {
    test("creates authorization with required fields", async () => {
      const auth = await createDeviceAuthorization(db, "google");

      expect(auth.deviceCode).toBeDefined();
      expect(auth.deviceCode.length).toBeGreaterThan(20);

      expect(auth.userCode).toBeDefined();
      expect(auth.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

      expect(auth.oauthState).toBeDefined();
      expect(auth.oauthState.length).toBeGreaterThan(10);

      expect(auth.expiresIn).toBe(900); // 15 minutes
      expect(auth.interval).toBe(5);
    });

    test("creates unique codes", async () => {
      const auth1 = await createDeviceAuthorization(db, "google");
      const auth2 = await createDeviceAuthorization(db, "google");

      expect(auth1.deviceCode).not.toBe(auth2.deviceCode);
      expect(auth1.userCode).not.toBe(auth2.userCode);
      expect(auth1.oauthState).not.toBe(auth2.oauthState);
    });
  });

  describe("getDeviceStateByUserCode", () => {
    test("finds state by user code", async () => {
      const auth = await createDeviceAuthorization(db, "google");
      const state = await getDeviceStateByUserCode(db, auth.userCode);

      expect(state).not.toBeNull();
      expect(state?.userCode).toBe(auth.userCode);
      expect(state?.provider).toBe("google");
    });

    test("normalizes user code (case insensitive, with/without hyphen)", async () => {
      const auth = await createDeviceAuthorization(db, "google");

      // Original format
      expect(await getDeviceStateByUserCode(db, auth.userCode)).not.toBeNull();

      // Lowercase
      expect(
        await getDeviceStateByUserCode(db, auth.userCode.toLowerCase()),
      ).not.toBeNull();

      // Without hyphen
      expect(
        await getDeviceStateByUserCode(db, auth.userCode.replace("-", "")),
      ).not.toBeNull();

      // Lowercase without hyphen
      expect(
        await getDeviceStateByUserCode(
          db,
          auth.userCode.toLowerCase().replace("-", ""),
        ),
      ).not.toBeNull();
    });

    test("returns null for unknown code", async () => {
      expect(await getDeviceStateByUserCode(db, "XXXX-XXXX")).toBeNull();
    });
  });

  describe("getDeviceStateByOAuthState", () => {
    test("finds state by OAuth state", async () => {
      const auth = await createDeviceAuthorization(db, "google");
      const state = await getDeviceStateByOAuthState(db, auth.oauthState);

      expect(state).not.toBeNull();
      expect(state?.oauthState).toBe(auth.oauthState);
    });

    test("returns null for unknown state", async () => {
      expect(await getDeviceStateByOAuthState(db, "unknown-state")).toBeNull();
    });
  });

  describe("getDeviceStateByDeviceCode", () => {
    test("finds state by device code", async () => {
      const auth = await createDeviceAuthorization(db, "google");
      const state = await getDeviceStateByDeviceCode(db, auth.deviceCode);

      expect(state).not.toBeNull();
      expect(state?.deviceCode).toBe(auth.deviceCode);
    });

    test("returns null for unknown code", async () => {
      expect(await getDeviceStateByDeviceCode(db, "unknown-code")).toBeNull();
    });
  });

  describe("checkPollRateLimit", () => {
    test("returns false on first poll", async () => {
      const auth = await createDeviceAuthorization(db, "google");
      expect(await checkPollRateLimit(db, auth.deviceCode)).toBe(false);
    });

    test("returns true when polling too fast", async () => {
      const auth = await createDeviceAuthorization(db, "google");

      // First poll
      await checkPollRateLimit(db, auth.deviceCode);

      // Immediate second poll should be rate limited
      expect(await checkPollRateLimit(db, auth.deviceCode)).toBe(true);
    });

    test("returns false for unknown device code", async () => {
      expect(await checkPollRateLimit(db, "unknown-code")).toBe(false);
    });
  });

  describe("authorizeDevice", () => {
    test("marks device as authorized", async () => {
      const auth = await createDeviceAuthorization(db, "google");
      const identityId = "019d694f-79f6-7595-8faf-b70b01c11f98";

      const result = await authorizeDevice(db, auth.deviceCode, identityId);
      expect(result).toBe(true);

      const state = await getDeviceStateByDeviceCode(db, auth.deviceCode);
      expect(state?.identityId).toBe(identityId);
    });

    test("returns false for unknown device code", async () => {
      const result = await authorizeDevice(
        db,
        "unknown-code",
        "019d694f-79f6-7595-8faf-b70b01c11f98",
      );
      expect(result).toBe(false);
    });
  });

  describe("denyDevice", () => {
    test("marks device as denied", async () => {
      const auth = await createDeviceAuthorization(db, "google");

      const result = await denyDevice(db, auth.deviceCode);
      expect(result).toBe(true);

      const state = await getDeviceStateByDeviceCode(db, auth.deviceCode);
      expect(state?.denied).toBe(true);
    });

    test("returns false for unknown device code", async () => {
      const result = await denyDevice(db, "unknown-code");
      expect(result).toBe(false);
    });
  });

  describe("cleanupDeviceState", () => {
    test("removes device state", async () => {
      const auth = await createDeviceAuthorization(db, "google");

      await cleanupDeviceState(db, auth.deviceCode);

      expect(await getDeviceStateByDeviceCode(db, auth.deviceCode)).toBeNull();
      expect(await getDeviceStateByUserCode(db, auth.userCode)).toBeNull();
      expect(await getDeviceStateByOAuthState(db, auth.oauthState)).toBeNull();
    });

    test("handles unknown device code gracefully", async () => {
      // Should not throw
      await cleanupDeviceState(db, "unknown-code");
    });
  });

  describe("cleanupExpiredStates", () => {
    test("removes expired states", async () => {
      // Create a state
      const auth = await createDeviceAuthorization(db, "google");

      // Manually expire it by modifying the store
      const store = (
        db as unknown as { _store: Map<string, DeviceAuthorization> }
      )._store;
      const state = store.get(auth.deviceCode);
      if (state) {
        state.expiresAt = new Date(Date.now() - 1000); // Expired 1 second ago
      }

      // Cleanup
      const cleaned = await cleanupExpiredStates(db);
      expect(cleaned).toBeGreaterThanOrEqual(1);

      // State should be gone
      expect(await getDeviceStateByDeviceCode(db, auth.deviceCode)).toBeNull();
    });
  });

  describe("state expiration", () => {
    test("expired state returns null on lookup", async () => {
      const auth = await createDeviceAuthorization(db, "google");

      // Manually expire it
      const store = (
        db as unknown as { _store: Map<string, DeviceAuthorization> }
      )._store;
      const state = store.get(auth.deviceCode);
      if (state) {
        state.expiresAt = new Date(Date.now() - 1000);
      }

      // Lookup should return null
      expect(await getDeviceStateByDeviceCode(db, auth.deviceCode)).toBeNull();
      expect(await getDeviceStateByUserCode(db, auth.userCode)).toBeNull();
      expect(await getDeviceStateByOAuthState(db, auth.oauthState)).toBeNull();
    });
  });
});
