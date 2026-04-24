type Brand<T, B extends string> = T & { readonly __brand: B };

export type DimensionId = Brand<string, 'DimensionId'>;
export type EntityRef = Brand<string, 'EntityRef'>;
export type TagValue = Brand<string, 'TagValue'>;
export type BucketPath = Brand<string, 'BucketPath'>;
export type Dollars = Brand<number, 'Dollars'>;
export type DateString = Brand<string, 'DateString'>;

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

export function tagColumnName(tagName: string): string {
  return `tag_${tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
}
