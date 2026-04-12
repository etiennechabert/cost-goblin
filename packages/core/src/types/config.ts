import type { BucketPath, DimensionId } from './branded.js';

export type NormalizationRule = 'lowercase' | 'uppercase' | 'lowercase-kebab' | 'lowercase-underscore' | 'camelCase';

export type ConceptType = 'owner' | 'product' | 'environment';

export interface ProviderConfig {
  readonly name: string;
  readonly type: 'aws';
  readonly credentials: AwsCredentials;
  readonly sync: SyncConfig;
}

export interface AwsCredentials {
  readonly profile: string;
}

export interface SyncConfig {
  readonly daily: SyncTierConfig;
  readonly hourly?: SyncTierConfig | undefined;
  readonly costOptimization?: SyncTierConfig | undefined;
  readonly intervalMinutes: number;
}

export interface SyncTierConfig {
  readonly bucket: BucketPath;
  readonly retentionDays: number;
}

export interface DefaultsConfig {
  readonly periodDays: number;
  readonly costMetric: string;
  readonly lagDays: number;
}

export interface CacheConfig {
  readonly ttlMinutes: number;
}

export interface CostGoblinConfig {
  readonly providers: readonly ProviderConfig[];
  readonly defaults: DefaultsConfig;
  readonly cache: CacheConfig;
}

export interface BuiltInDimension {
  readonly name: DimensionId;
  readonly label: string;
  readonly field: string;
  readonly displayField?: string | undefined;
}

export interface TagDimension {
  readonly tagName: string;
  readonly label: string;
  readonly concept?: ConceptType | undefined;
  readonly normalize?: NormalizationRule | undefined;
  readonly separator?: string | undefined;
  readonly aliases?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly accountTagFallback?: string | undefined;
  readonly missingValueTemplate?: string | undefined;
}

export interface DimensionsConfig {
  readonly builtIn: readonly BuiltInDimension[];
  readonly tags: readonly TagDimension[];
}

export interface OrgNode {
  readonly name: string;
  readonly virtual?: true | undefined;
  readonly children?: readonly OrgNode[] | undefined;
}

export interface OrgTreeConfig {
  readonly tree: readonly OrgNode[];
}
