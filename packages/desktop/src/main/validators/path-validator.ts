import { SecurityError } from '@costgoblin/core';

const VALID_LABEL = /^[a-zA-Z0-9_-]+$/;

export function validateProfileLabel(label: string): void {
  if (!VALID_LABEL.test(label)) {
    throw new SecurityError(`Invalid profile label "${label}" — only [a-zA-Z0-9_-] allowed`);
  }
}
