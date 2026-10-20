/** Preserve the login request but discard errors from the previous attempt. */
export function clearSignInError(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has("error") && !params.has("error_description")) return search;
  params.delete("error");
  params.delete("error_description");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Read the OAuth callback error shared by web, CLI, device, and invite login pages. */
export function readSignInError(search: string): string | null {
  const params = new URLSearchParams(search);
  const description = params.get("error_description");
  if (description) return description;
  const code = params.get("error");
  if (!code) return null;
  // User-creation failures arrive as message tokens, without error_description.
  const signupDomain = /^SIGNUP_RESTRICTED:([a-z0-9.-]+)$/.exec(code)?.[1];
  if (signupDomain) {
    return `New registrations are currently limited to verified @${signupDomain} email addresses. Existing users can continue to sign in.`;
  }
  return code === "EMAIL_NOT_VERIFIED"
    ? "Your email is not verified with your identity provider. Verify it with GitHub or Google, then sign in again."
    : "Sign-in failed. Please try again.";
}
