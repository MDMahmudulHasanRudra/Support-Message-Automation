/**
 * Whether a Main Admin may APPLY a conversion of existing client codes (CLIENT_CODES.md §Conversion). Off unless
 * the installation sets CLIENT_CODE_CONVERSION_ENABLED=true: the preview and its export always work, so the change
 * can be reviewed (and backed up) before anybody switches the apply on.
 */
export function clientCodeConversionEnabled(): boolean {
  return process.env.CLIENT_CODE_CONVERSION_ENABLED === "true";
}
