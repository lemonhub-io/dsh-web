/** Cloudflare module Worker entry used by the standalone deployment and its focused test. */
declare const worker: {
  /**
   * Serve a public GitHub read with credential isolation and bounded responses.
   * @param request Incoming Worker request.
   * @param env Deployment variables and the optional GitHub secret.
   * @param context Owns asynchronous cache writes.
   * @returns CORS-enabled data or a structured HTTP error.
   */
  fetch(request: Request, env: Record<string, string | undefined>, context: {
    waitUntil(operation: Promise<unknown>): void
  }): Promise<Response>
}
export default worker
