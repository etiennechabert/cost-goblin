type Brand<T, B extends string> = T & { readonly __brand: B };

export type DimensionId = Brand<string, 'DimensionId'>;
export type EntityRef = Brand<string, 'EntityRef'>;
export type TagValue = Brand<string, 'TagValue'>;
export type BucketPath = Brand<string, 'BucketPath'>;
export type Dollars = Brand<number, 'Dollars'>;
export type DateString = Brand<string, 'DateString'>;
export type HourString = Brand<string, 'HourString'>;

export function asDimensionId(value: string): DimensionId {
  return value as DimensionId;
}

export function asEntityRef(value: string): EntityRef {
  return value as EntityRef;
}

export function asTagValue(value: string): TagValue {
  return value as TagValue;
}

export function asBucketPath(value: string): BucketPath {
  return value as BucketPath;
}

export function asDollars(value: number): Dollars {
  return value as Dollars;
}

export function asDateString(value: string): DateString {
  return value as DateString;
}

export function asHourString(value: string): HourString {
  return value as HourString;
}

export function tagColumnName(tagName: string): string {
  return `tag_${tagName.replaceAll(/[^a-zA-Z0-9]/g, '_')}`;
}

/** Returns the SQL column name for a tag dimension. When the dimension has no
 *  resource `tagName` (account-only dimension), the column name is derived
 *  from the account-level source: `tag_ou_path` for the OU Path sentinel, or
 *  a slugified `accountTagFallback`. */
export function tagDimColumn(t: { readonly tagName?: string | undefined; readonly accountTagFallback?: string | undefined }): string {
  if (t.tagName !== undefined && t.tagName.length > 0) return tagColumnName(t.tagName);
  const fallback = t.accountTagFallback;
  if (fallback === '__ouPath__') return tagColumnName('ou_path');
  if (fallback !== undefined && fallback.length > 0) return tagColumnName(fallback);
  return tagColumnName('unknown');
}
