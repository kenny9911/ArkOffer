/** Email and InMail have subject fields; other manual channels may use an optional task title. */
export function sequenceRequiresSubject(kind: string): boolean {
  return ["email", "manual_email", "linkedin_inmail"].includes(kind);
}
