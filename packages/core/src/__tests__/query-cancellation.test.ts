import { describe, expect, it } from 'vitest';
import { QUERY_CANCELLED_MESSAGE, isQueryCancelled } from '../query/cancellation.js';

describe('isQueryCancelled', () => {
  it('recognizes the message as the worker emits it', () => {
    expect(isQueryCancelled(new Error(QUERY_CANCELLED_MESSAGE))).toBe(true);
  });

  it('recognizes it as Electron hands it to the renderer', () => {
    expect(isQueryCancelled(new Error(`Error invoking remote method 'query:costs': Error: ${QUERY_CANCELLED_MESSAGE}`))).toBe(true);
  });

  it('reads a rejection that is not an Error', () => {
    expect(isQueryCancelled(QUERY_CANCELLED_MESSAGE)).toBe(true);
    expect(isQueryCancelled(undefined)).toBe(false);
  });

  it('leaves a real failure alone, even one that mentions the phrase', () => {
    expect(isQueryCancelled(new Error("Error invoking remote method 'query:costs': Error: Out of Memory Error"))).toBe(false);
    expect(isQueryCancelled(new Error(`${QUERY_CANCELLED_MESSAGE} while reading a file: IO Error`))).toBe(false);
    expect(isQueryCancelled(new Error(`Not a ${QUERY_CANCELLED_MESSAGE}`))).toBe(false);
  });
});
