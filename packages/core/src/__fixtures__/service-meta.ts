export interface ServiceMeta {
  readonly family: string;
  readonly operations: readonly string[];
}

export const SERVICE_META: Record<string, ServiceMeta> = {
  AmazonEC2:        { family: 'Compute',                  operations: ['RunInstances', 'StartInstances', 'StopInstances'] },
  AmazonRDS:        { family: 'Database',                 operations: ['CreateDBInstance', 'CreateDBSnapshot', 'BackupRetention'] },
  AmazonS3:         { family: 'Storage',                  operations: ['PutObject', 'GetObject', 'ListBucket'] },
  AWSLambda:        { family: 'Compute',                  operations: ['Invoke', 'GetFunction'] },
  AmazonCloudWatch: { family: 'Management & Governance',  operations: ['PutMetricData', 'GetMetricData', 'PutLogEvents'] },
  AmazonDynamoDB:   { family: 'Database',                 operations: ['GetItem', 'PutItem', 'Query'] },
  AmazonVPC:        { family: 'Networking',               operations: ['CreateVpc', 'NatGateway', 'VPNConnection'] },
  AWSBackup:        { family: 'Storage',                  operations: ['CreateBackupVault', 'StartBackupJob'] },
  AmazonECR:        { family: 'Compute',                  operations: ['PutImage', 'GetDownloadUrlForLayer'] },
  AmazonSNS:        { family: 'Application Integration',  operations: ['Publish', 'Subscribe'] },
  AmazonSQS:        { family: 'Application Integration',  operations: ['SendMessage', 'ReceiveMessage'] },
  AWSCloudTrail:    { family: 'Management & Governance',  operations: ['LookupEvents', 'CreateTrail'] },
  AmazonRoute53:    { family: 'Networking',               operations: ['ChangeResourceRecordSets', 'GetHostedZone'] },
  AmazonEFS:        { family: 'Storage',                  operations: ['CreateFileSystem', 'ClientMount'] },
};

export const DEFAULT_META: ServiceMeta = { family: 'General', operations: ['Unknown'] };
