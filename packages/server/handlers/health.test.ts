import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as logfire from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { healthHandler, readyHandler } from "./health";

// A fake postgres.js `Sql` that resolves or rejects the tagged `SELECT 1`.
// The handler only ever calls it as a template tag, so the args are ignored.
function fakeDb(result: () => Promise<unknown>): Sql {
  return (() => result()) as unknown as Sql;
}

const okDb = () => fakeDb(() => Promise.resolve([{ "?column?": 1 }]));
const downDb = (message: string) =>
  fakeDb(() => Promise.reject(new Error(message)));

afterEach(() => {
  // Restore any spies installed in a test.
  (logfire.error as ReturnType<typeof spyOn>).mockRestore?.();
});

describe("healthHandler", () => {
  test("returns 200 ok without touching the database", async () => {
    const response = healthHandler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("readyHandler", () => {
  test("returns 200 with checks.db ok when the database is reachable", async () => {
    const errorSpy = spyOn(logfire, "error").mockImplementation(() => {});
    const response = await readyHandler(okDb())(
      new Request("http://localhost/ready"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      checks: { db: string };
    };
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
    // No failure log on the happy path.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("returns 503 and emits a 'Readiness check failed' error log when the database is down", async () => {
    const errorSpy = spyOn(logfire, "error").mockImplementation(() => {});
    const response = await readyHandler(downDb("connection refused"))(
      new Request("http://localhost/ready"),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      status: string;
      checks: { db: string };
    };
    expect(body.status).toBe("unavailable");
    expect(body.checks.db).toContain("connection refused");
    // The alert keys off this exact message at error level.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe("Readiness check failed");
  });
});
