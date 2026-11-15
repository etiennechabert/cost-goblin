import { ConfigValidationError } from '../../config/validator.js';

/** The message of the ConfigValidationError `fn` throws; anything else fails the test. */
export function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but nothing was thrown');
}
