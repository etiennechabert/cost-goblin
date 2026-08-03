export interface ServiceMeta {
  /** FOCUS `ServiceName` — the display name AWS emits (including real AWS
   *  quirks like "AmazonCloudWatch", verified against a live FOCUS export). */
  readonly serviceName: string;
  /** FOCUS `ServiceCategory` — one of the ~13 standardized cross-provider
   *  categories. */
  readonly category: string;
  readonly operations: readonly string[];
}

/** Keyed by `x_ServiceCode` (the CUR-style exact code). */
export const SERVICE_META: Record<string, ServiceMeta> = {
  AmazonEC2:        { serviceName: 'Amazon Elastic Compute Cloud',       category: 'Compute',                   operations: ['RunInstances', 'StartInstances', 'StopInstances'] },
  AmazonRDS:        { serviceName: 'Amazon Relational Database Service', category: 'Databases',                 operations: ['CreateDBInstance', 'CreateDBSnapshot', 'BackupRetention'] },
  AmazonS3:         { serviceName: 'Amazon Simple Storage Service',      category: 'Storage',                   operations: ['PutObject', 'GetObject', 'ListBucket'] },
  AWSLambda:        { serviceName: 'AWS Lambda',                         category: 'Compute',                   operations: ['Invoke', 'GetFunction'] },
  AmazonCloudWatch: { serviceName: 'AmazonCloudWatch',                   category: 'Management and Governance', operations: ['PutMetricData', 'GetMetricData', 'PutLogEvents'] },
  AmazonDynamoDB:   { serviceName: 'Amazon DynamoDB',                    category: 'Databases',                 operations: ['GetItem', 'PutItem', 'Query'] },
  AmazonVPC:        { serviceName: 'Amazon Virtual Private Cloud',       category: 'Networking',                operations: ['CreateVpc', 'NatGateway', 'VPNConnection'] },
  AWSBackup:        { serviceName: 'AWS Backup',                         category: 'Storage',                   operations: ['CreateBackupVault', 'StartBackupJob'] },
  AmazonECR:        { serviceName: 'Amazon EC2 Container Registry',      category: 'Compute',                   operations: ['PutImage', 'GetDownloadUrlForLayer'] },
  AmazonSNS:        { serviceName: 'Amazon Simple Notification Service', category: 'Integration',               operations: ['Publish', 'Subscribe'] },
  AmazonSQS:        { serviceName: 'Amazon Simple Queue Service',        category: 'Integration',               operations: ['SendMessage', 'ReceiveMessage'] },
  AWSCloudTrail:    { serviceName: 'AWS CloudTrail',                     category: 'Management and Governance', operations: ['LookupEvents', 'CreateTrail'] },
  AmazonRoute53:    { serviceName: 'Amazon Route 53',                    category: 'Networking',                operations: ['ChangeResourceRecordSets', 'GetHostedZone'] },
  AmazonEFS:        { serviceName: 'Amazon Elastic File System',         category: 'Storage',                   operations: ['CreateFileSystem', 'ClientMount'] },
};

export const DEFAULT_META: ServiceMeta = { serviceName: 'Unknown Service', category: 'Other', operations: ['Unknown'] };
