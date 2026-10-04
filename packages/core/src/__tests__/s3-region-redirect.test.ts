import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { profileRegion, s3ClientConfig } from '../sync/s3-client.js';

/** The real SDK against a fake S3 whose bucket lives in eu-west-1: any other
 *  regional endpoint answers with the 301 PermanentRedirect S3 sends, which
 *  carries the bucket's region in `x-amz-bucket-region`. No network. */
const BUCKET = 'cost-goblin-demo-123456789012-eu-west-1-an';
const BUCKET_REGION = 'eu-west-1';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function fakeS3(): { requestHandler: { handle(request: { hostname: string }): Promise<{ response: { statusCode: number; headers: Record<string, string>; body: Uint8Array } }>; updateHttpClientConfig(): void; httpHandlerConfigs(): Record<string, never> }; hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    requestHandler: {
      handle(request) {
        hosts.push(request.hostname);
        if (!request.hostname.includes(`.s3.${BUCKET_REGION}.`)) {
          return Promise.resolve({
            response: {
              statusCode: 301,
              headers: { 'content-type': 'application/xml', 'x-amz-bucket-region': BUCKET_REGION },
              body: encode(
                '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PermanentRedirect</Code>' +
                '<Message>The bucket you are attempting to access must be addressed using the specified endpoint. Please send all future requests to this endpoint.</Message>' +
                `<Endpoint>${BUCKET}.s3-${BUCKET_REGION}.amazonaws.com</Endpoint><Bucket>${BUCKET}</Bucket></Error>`,
              ),
            },
          });
        }
        return Promise.resolve({
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/xml' },
            body: encode(
              '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
              `<Name>${BUCKET}</Name><Prefix></Prefix><KeyCount>2</KeyCount><MaxKeys>200</MaxKeys><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated>` +
              '<CommonPrefixes><Prefix>data/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>metadata/</Prefix></CommonPrefixes>' +
              '</ListBucketResult>',
            ),
          },
        });
      },
      updateHttpClientConfig() { /* fixed fake */ },
      httpHandlerConfigs() { return {}; },
    },
  };
}

/** Client options that keep the developer's own AWS setup out of the test.
 *  The real SDK reads dual-stack, FIPS and `endpoint_url` from the env and
 *  from ~/.aws/config; any of them moves the hostnames the fake routes on, so
 *  the redirected request would get a 301 too and the test would fail. */
const hermetic = {
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
  useDualstackEndpoint: false,
  useFipsEndpoint: false,
  ignoreConfiguredEndpointUrls: true,
};
const browse = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: '', Delimiter: '/', MaxKeys: 200 });

/** Point the SDK's config loader at a throwaway ~/.aws/config, so the
 *  developer's own profiles never decide where a client starts. */
const configDirs: string[] = [];
function useAwsConfig(contents: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'costgoblin-aws-'));
  configDirs.push(dir);
  writeFileSync(join(dir, 'config'), contents);
  vi.stubEnv('AWS_CONFIG_FILE', join(dir, 'config'));
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(dir, 'credentials'));
}

beforeEach(() => {
  useAwsConfig('');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of configDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('profileRegion', () => {
  it('reads a named profile’s region', async () => {
    useAwsConfig('[profile billing]\nregion = eu-west-1\n');
    await expect(profileRegion('billing')).resolves.toBe('eu-west-1');
  });

  it('falls back to the sso-session region of an SSO-only profile', async () => {
    useAwsConfig('[profile sso]\nsso_session = corp\n\n[sso-session corp]\nsso_region = eu-north-1\n');
    await expect(profileRegion('sso')).resolves.toBe('eu-north-1');
  });

  it.each([
    ['an unknown profile', '[profile billing]\nregion = eu-west-1\n', 'other'],
    ['a profile with no region or session', '[profile bare]\noutput = json\n', 'bare'],
    ['a session with no region', '[profile sso]\nsso_session = corp\n\n[sso-session corp]\nsso_start_url = https://example.awsapps.com/start\n', 'sso'],
    ['a dangling session', '[profile sso]\nsso_session = gone\n', 'sso'],
  ])('finds no region for %s', async (_label, contents, profile) => {
    useAwsConfig(contents);
    await expect(profileRegion(profile)).resolves.toBeUndefined();
  });

  it('finds no region when the config file is missing', async () => {
    vi.stubEnv('AWS_CONFIG_FILE', join(tmpdir(), `costgoblin-no-aws-config-${String(process.pid)}`));
    await expect(profileRegion('default')).resolves.toBeUndefined();
  });
});

describe('s3ClientConfig', () => {
  it('starts in eu-central-1 when the profile names no region', async () => {
    await expect(s3ClientConfig('default')).resolves.toEqual({ region: 'eu-central-1', followRegionRedirects: true });
  });

  it('starts in the profile’s own region', async () => {
    useAwsConfig('[profile billing]\nregion = eu-west-1\n');
    await expect(s3ClientConfig('billing')).resolves.toEqual({ region: 'eu-west-1', followRegionRedirects: true, profile: 'billing' });
  });

  it('reads the default profile’s region without naming the profile', async () => {
    useAwsConfig('[default]\nregion = ap-southeast-2\n');
    await expect(s3ClientConfig('default')).resolves.toEqual({ region: 'ap-southeast-2', followRegionRedirects: true });
  });

  it('lets an explicit region win over the profile’s', async () => {
    useAwsConfig('[profile billing]\nregion = eu-west-1\n');
    await expect(s3ClientConfig('billing', 'us-west-2')).resolves.toEqual({ region: 'us-west-2', followRegionRedirects: true, profile: 'billing' });
  });

  it('looks up no profile when the caller brings its own credentials', async () => {
    useAwsConfig('[default]\nregion = ap-southeast-2\n');
    await expect(s3ClientConfig(undefined)).resolves.toEqual({ region: 'eu-central-1', followRegionRedirects: true });
  });

  it('reaches a bucket outside the starting region by following the 301', async () => {
    const { requestHandler, hosts } = fakeS3();
    const client = new S3Client({ ...(await s3ClientConfig('default')), ...hermetic, requestHandler });

    const response = await client.send(browse);

    expect(response.CommonPrefixes?.map(p => p.Prefix)).toEqual(['data/', 'metadata/']);
    expect(hosts).toEqual([
      `${BUCKET}.s3.eu-central-1.amazonaws.com`,
      `${BUCKET}.s3.${BUCKET_REGION}.amazonaws.com`,
    ]);
  });

  it('needs no redirect when the bucket is in the profile’s region', async () => {
    useAwsConfig(`[default]\nregion = ${BUCKET_REGION}\n`);
    const { requestHandler, hosts } = fakeS3();
    const client = new S3Client({ ...(await s3ClientConfig('default')), ...hermetic, requestHandler });

    await client.send(browse);

    expect(hosts).toEqual([`${BUCKET}.s3.${BUCKET_REGION}.amazonaws.com`]);
  });

  it('is what stands between the wizard and the PermanentRedirect error', async () => {
    const { requestHandler } = fakeS3();
    const client = new S3Client({ region: 'eu-central-1', ...hermetic, requestHandler });

    await expect(client.send(browse)).rejects.toThrow('must be addressed using the specified endpoint');
  });
});

// The redirect only helps clients that ask for it: the wizard's handlers each
// built a bare `new S3Client({ region })`, so a bucket outside that region
// failed in every one of them. Pin the helper as the only way in.
describe('S3 client policy', () => {
  const packagesDir = join(import.meta.dirname, '..', '..', '..');
  const sources = readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(pkg => {
      const srcDir = join(packagesDir, pkg.name, 'src');
      let files: string[];
      try {
        files = readdirSync(srcDir, { recursive: true, encoding: 'utf-8' });
      } catch {
        return [];
      }
      return files
        .filter(file => /\.tsx?$/.test(file) && !file.split(/[\\/]/).includes('__tests__'))
        .map(file => ({ file: join(pkg.name, 'src', file), text: readFileSync(join(srcDir, file), 'utf-8') }));
    });

  /** Every `new S3Client(`, including through a namespace or module object
   *  (`new s3.S3Client(` off `await import('@aws-sdk/client-s3')`). Group 1
   *  holds the start of the options argument. */
  const constructions = (text: string): RegExpExecArray[] =>
    [...text.matchAll(/\bnew\s+(?:[\w$]+\.)*S3Client\(\s*([^)]{0,40})/g)];

  it('finds the app sources that build S3 clients', () => {
    const builders = sources.filter(s => constructions(s.text).length > 0).map(s => s.file);
    expect(builders).toContain(join('core', 'src', 'sync', 's3-client.ts'));
  });

  it('starts every S3Client from s3ClientConfig', () => {
    const bare = sources.flatMap(s =>
      constructions(s.text)
        .filter(m => !/^(?:\{\s*\.\.\.\(?)?(?:await\s+)?s3ClientConfig\(/.test(m[1] ?? ''))
        .map(() => s.file));
    expect(bare).toEqual([]);
  });

  it('never switches the redirect back off after the helper', () => {
    const disabled = sources.filter(s => /\bfollowRegionRedirects\s*:\s*false\b/.test(s.text)).map(s => s.file);
    expect(disabled).toEqual([]);
  });
});
