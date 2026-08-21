const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** Rejects profile identifiers that could escape DSH_HOME/profiles. */
export function assertProfileName(value: string): void {
  if (!PROFILE_NAME.test(value)) throw new TypeError('Invalid profile name.')
}
