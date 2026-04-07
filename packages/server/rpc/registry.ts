import type { z } from "zod";
import type { MethodHandler, MethodRegistry, RegisteredMethod } from "./types";

/**
 * Create a new method registry.
 */
export function createRegistry(): MethodRegistry {
  return new Map();
}

/**
 * Register a method with its schema and handler.
 *
 * @param registry - The method registry
 * @param method - The method name (e.g., "memory.create")
 * @param schema - Zod schema for validating params
 * @param handler - Handler function
 */
export function registerMethod<TParams, TResult>(
  registry: MethodRegistry,
  method: string,
  schema: z.ZodType<TParams>,
  handler: MethodHandler<TParams, TResult>,
): void {
  registry.set(method, {
    schema,
    handler: handler as MethodHandler,
  });
}

/**
 * Get a registered method by name.
 *
 * @param registry - The method registry
 * @param method - The method name
 * @returns The registered method or undefined
 */
export function getMethod(
  registry: MethodRegistry,
  method: string,
): RegisteredMethod | undefined {
  return registry.get(method);
}

/**
 * Check if a method is registered.
 *
 * @param registry - The method registry
 * @param method - The method name
 */
export function hasMethod(registry: MethodRegistry, method: string): boolean {
  return registry.has(method);
}

/**
 * List all registered method names.
 *
 * @param registry - The method registry
 */
export function listMethods(registry: MethodRegistry): string[] {
  return Array.from(registry.keys());
}

/**
 * Builder pattern for creating a registry with fluent API.
 */
export class RegistryBuilder {
  private registry: MethodRegistry;

  constructor() {
    this.registry = createRegistry();
  }

  /**
   * Register a method.
   */
  register<TParams, TResult>(
    method: string,
    schema: z.ZodType<TParams>,
    handler: MethodHandler<TParams, TResult>,
  ): this {
    registerMethod(this.registry, method, schema, handler);
    return this;
  }

  /**
   * Merge another registry into this one.
   */
  merge(other: MethodRegistry): this {
    for (const [method, registered] of other) {
      this.registry.set(method, registered);
    }
    return this;
  }

  /**
   * Build and return the registry.
   */
  build(): MethodRegistry {
    return this.registry;
  }
}

/**
 * Create a registry builder for fluent registration.
 */
export function buildRegistry(): RegistryBuilder {
  return new RegistryBuilder();
}
