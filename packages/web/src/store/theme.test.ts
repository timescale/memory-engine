/**
 * Theme store: DOM class + localStorage interactions, exercised against
 * minimal stubs (bun test has no DOM).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const classes = new Set<string>();
const stored = new Map<string, string>();

// bun runs test files in a shared process, so restore the stubbed globals
// after this file to keep them from leaking into other tests.
const originalDocument = Reflect.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalLocalStorage = Reflect.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

afterAll(() => {
  restoreGlobal("document", originalDocument);
  restoreGlobal("localStorage", originalLocalStorage);
});

function restoreGlobal(
  name: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

beforeAll(() => {
  globalThis.document = {
    documentElement: {
      classList: {
        contains: (cls: string) => classes.has(cls),
        toggle: (cls: string, force: boolean) => {
          if (force) classes.add(cls);
          else classes.delete(cls);
          return force;
        },
      },
    },
  } as unknown as Document;
  globalThis.localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  } as unknown as Storage;
});

test("initializes from the <html> class and toggle flips class + persists", async () => {
  // Import after the stubs land: the store reads the DOM at module eval.
  const { useTheme } = await import("./theme.ts");

  expect(useTheme.getState().theme).toBe("light");

  useTheme.getState().toggle();
  expect(useTheme.getState().theme).toBe("dark");
  expect(classes.has("dark")).toBe(true);
  expect(stored.get("me-theme")).toBe("dark");

  useTheme.getState().toggle();
  expect(useTheme.getState().theme).toBe("light");
  expect(classes.has("dark")).toBe(false);
  expect(stored.get("me-theme")).toBe("light");
});
