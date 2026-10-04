import { describe, it, expect } from 'vitest';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { s3ClientConfig } from '../sync/s3-client.js';

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

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
const browse = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: '', Delimiter: '/', MaxKeys: 200 });

describe('s3ClientConfig', () => {
  it('follows region redirects and defaults the starting region', () => {
    expect(s3ClientConfig('default')).toEqual({ region: 'eu-central-1', followRegionRedirects: true });
  });

  it('passes a named profile through and honours an explicit region', () => {
    expect(s3ClientConfig('billing', 'us-west-2')).toEqual({ region: 'us-west-2', followRegionRedirects: true, profile: 'billing' });
  });

  it('reaches a bucket outside the starting region by following the 301', async () => {
    const { requestHandler, hosts } = fakeS3();
    const client = new S3Client({ ...s3ClientConfig('default'), credentials, requestHandler });

    const response = await client.send(browse);

    expect(response.CommonPrefixes?.map(p => p.Prefix)).toEqual(['data/', 'metadata/']);
    expect(hosts).toEqual([
      `${BUCKET}.s3.eu-central-1.amazonaws.com`,
      `${BUCKET}.s3.${BUCKET_REGION}.amazonaws.com`,
    ]);
  });

  it('is what stands between the wizard and the PermanentRedirect error', async () => {
    const { requestHandler } = fakeS3();
    const client = new S3Client({ region: 'eu-central-1', credentials, requestHandler });

    await expect(client.send(browse)).rejects.toThrow('must be addressed using the specified endpoint');
  });
});
