import { describe, expect, it } from 'vitest';
import { dimensionsConfigToYaml } from '../config/dimensions-serialize.js';
import { validateDimensions } from '../config/validator.js';
import { asDimensionId } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';
import { OU_PATH_SOURCE_KEY } from '../types/config.js';

const account = { name: asDimensionId('account'), label: 'Account', field: 'account_id' };

describe('dimensionsConfigToYaml: tags without a resource tag key', () => {
  it('writes no tagName for an account-only tag dimension', () => {
    const yaml = dimensionsConfigToYaml({ builtIn: [], tags: [{ label: 'OU', accountTagFallback: OU_PATH_SOURCE_KEY }] });
    expect(yaml['tags']).toStrictEqual([{ label: 'OU', accountTagFallback: OU_PATH_SOURCE_KEY }]);
  });

  it('writes no tagName for an empty one', () => {
    const yaml = dimensionsConfigToYaml({ builtIn: [], tags: [{ tagName: '', label: 'Owner', accountTagFallback: 'Owner' }] });
    expect(yaml['tags']).toStrictEqual([{ label: 'Owner', accountTagFallback: 'Owner' }]);
  });
});

describe('dimensionsConfigToYaml: normalize, separator and order', () => {
  it('writes a tag normalize rule and separator only when they are set', () => {
    const yaml = dimensionsConfigToYaml({
      builtIn: [],
      tags: [{ tagName: 'team', label: 'Team', normalize: 'lowercase-kebab', separator: '/' }, { tagName: 'env', label: 'Env' }],
    });
    expect(yaml['tags']).toStrictEqual([
      { tagName: 'team', label: 'Team', normalize: 'lowercase-kebab', separator: '/' },
      { tagName: 'env', label: 'Env' },
    ]);
  });

  it('writes a copy of the dimension order when one is set, and no order key otherwise', () => {
    const order = ['tag:team', 'builtin:account'];
    const withOrder = dimensionsConfigToYaml({ builtIn: [account], tags: [{ tagName: 'team', label: 'Team' }], order });
    expect(withOrder['order']).toStrictEqual(['tag:team', 'builtin:account']);
    expect(withOrder['order']).not.toBe(order);
    expect(Object.keys(withOrder)).toEqual(['builtIn', 'tags', 'order']);
    expect(dimensionsConfigToYaml({ builtIn: [account], tags: [] })).toStrictEqual({
      builtIn: [{ name: 'account', label: 'Account', field: 'account_id' }],
      tags: [],
    });
  });

  it('round-trips an account-only tag, normalize, a separator and an order through validateDimensions', () => {
    const cfg: DimensionsConfig = {
      builtIn: [account],
      tags: [
        { label: 'OU', accountTagFallback: OU_PATH_SOURCE_KEY },
        { tagName: 'team', label: 'Team', normalize: 'lowercase-kebab', separator: '/' },
      ],
      order: ['tag:team', 'builtin:account'],
    };
    expect(validateDimensions(dimensionsConfigToYaml(cfg))).toStrictEqual(cfg);
  });
});
