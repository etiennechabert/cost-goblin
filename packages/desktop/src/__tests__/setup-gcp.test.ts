import { describe, it, expect } from 'vitest';
import { extractGcsPrefixNames, parseGcloudProjects } from '../main/setup-gcp.js';

describe('parseGcloudProjects', () => {
  it('reads the shape `gcloud projects list --format=json` emits', () => {
    const stdout = JSON.stringify([
      { projectId: 'acme-prod', name: 'Acme Production', lifecycleState: 'ACTIVE' },
      { projectId: 'acme-dev', name: 'Acme Dev', lifecycleState: 'ACTIVE' },
    ]);
    expect(parseGcloudProjects(stdout)).toEqual([
      { projectId: 'acme-prod', name: 'Acme Production' },
      { projectId: 'acme-dev', name: 'Acme Dev' },
    ]);
  });

  it('falls back to the id when a project has no display name', () => {
    const stdout = JSON.stringify([{ projectId: 'nameless' }]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'nameless', name: 'nameless' }]);
  });

  it('drops projects that are not ACTIVE', () => {
    // A DELETE_REQUESTED project still lists, but its buckets are already
    // going away — offering it sends the user down a dead end.
    const stdout = JSON.stringify([
      { projectId: 'live', name: 'Live', lifecycleState: 'ACTIVE' },
      { projectId: 'doomed', name: 'Doomed', lifecycleState: 'DELETE_REQUESTED' },
    ]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'live', name: 'Live' }]);
  });

  it('keeps a project whose lifecycleState the CLI omitted', () => {
    // Absent is not the same as non-ACTIVE; older CLI versions and some
    // --format filters drop the field entirely.
    const stdout = JSON.stringify([{ projectId: 'p', name: 'P' }]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'p', name: 'P' }]);
  });

  it('skips entries with no usable projectId rather than inventing one', () => {
    const stdout = JSON.stringify([{ name: 'No Id' }, { projectId: '', name: 'Blank' }, { projectId: 'ok' }]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'ok', name: 'ok' }]);
  });

  it('returns empty for the CLI s empty listing', () => {
    expect(parseGcloudProjects('[]')).toEqual([]);
  });

  it('returns empty rather than throwing on non-JSON stdout', () => {
    // gcloud prints update nags and auth prompts to stdout in some configs.
    expect(parseGcloudProjects('You do not currently have an active account')).toEqual([]);
    expect(parseGcloudProjects('')).toEqual([]);
  });

  it('returns empty when the payload is a JSON object rather than an array', () => {
    expect(parseGcloudProjects('{"projectId":"x"}')).toEqual([]);
  });
});

describe('extractGcsPrefixNames', () => {
  it('returns child folder names relative to the browsed prefix', () => {
    const apiResponse = { prefixes: ['focus/daily/', 'focus/hourly/'] };
    expect(extractGcsPrefixNames(apiResponse, 'focus/')).toEqual(['daily', 'hourly']);
  });

  it('handles the bucket root, where the prefix is empty', () => {
    const apiResponse = { prefixes: ['focus/', 'logs/'] };
    expect(extractGcsPrefixNames(apiResponse, '')).toEqual(['focus', 'logs']);
  });

  it('returns empty when the response carries no prefixes key', () => {
    // A folder holding only objects (no subfolders) omits `prefixes` entirely.
    expect(extractGcsPrefixNames({ items: [] }, 'focus/')).toEqual([]);
  });

  it('returns empty for a response that is not an object', () => {
    expect(extractGcsPrefixNames(undefined, '')).toEqual([]);
    expect(extractGcsPrefixNames(null, '')).toEqual([]);
    expect(extractGcsPrefixNames('nope', '')).toEqual([]);
  });

  it('ignores non-string entries inside prefixes', () => {
    expect(extractGcsPrefixNames({ prefixes: ['a/', 42, null] }, '')).toEqual(['a']);
  });

  it('drops a prefix that does not sit under the browsed one', () => {
    // Defensive: slicing by length would otherwise mangle the name into a
    // folder the user can click but that resolves nowhere.
    expect(extractGcsPrefixNames({ prefixes: ['other/thing/'] }, 'focus/')).toEqual([]);
  });

  it('drops the self-referential prefix rather than emitting an empty name', () => {
    expect(extractGcsPrefixNames({ prefixes: ['focus/'] }, 'focus/')).toEqual([]);
  });
});
