/**
 * Password hashing utilities using Bun's built-in Argon2id
 */

/**
 * Hash a password using Argon2id
 */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 19456, // 19 MiB (OWASP recommended minimum)
    timeCost: 2,
  });
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
