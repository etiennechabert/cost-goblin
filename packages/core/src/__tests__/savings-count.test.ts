import { describe, expect, it } from 'vitest';
import { countSavings, HIGHEST_SAVINGS } from '../savings/count.js';
import { parseSavingsRow } from '../savings/coh-rows.js';
import type { CommitmentPaymentOption, CommitmentTerm, SavingsRecommendation } from '../types/query.js';

// Cost Optimization Hub lists every way to buy the same commitment and every
// action on the same resource. These rows mirror the shapes of a real export
// (the demo workspace's 2026-10-13 snapshot): one Compute Savings Plan per
// term and payment option, EC2 Instance Savings Plans and EC2 RIs over the
// same t2 usage, RDS RIs per deployment option, and resources with more than
// one action.

interface RowSpec {
  readonly id: string;
  readonly action: string;
  readonly type: string;
  readonly savings: number;
  readonly cost: number;
  readonly provider?: string;
  readonly account?: string;
  readonly region?: string;
  readonly arn?: string;
  readonly effort?: string;
  readonly summary?: string;
  readonly currentSummary?: string;
  readonly current?: unknown;
  readonly recommended?: unknown;
}

function rec(spec: RowSpec): SavingsRecommendation {
  const parsed = parseSavingsRow({
    recommendation_id: spec.id,
    account_id: spec.account ?? '123456789012',
    account_name: 'Demo',
    action_type: spec.action,
    current_resource_type: spec.type,
    summary: spec.summary ?? '',
    region: spec.region ?? 'eu-west-1',
    monthly_savings: spec.savings,
    monthly_cost: spec.cost,
    savings_pct: spec.cost > 0 ? (spec.savings / spec.cost) * 100 : 0,
    effort: spec.effort ?? 'VeryLow',
    resource_arn: spec.arn ?? '',
    current_details: spec.current === undefined ? '' : JSON.stringify(spec.current),
    recommended_details: spec.recommended === undefined ? '' : JSON.stringify(spec.recommended),
    current_summary: spec.currentSummary ?? '',
    restart_needed: false,
    rollback_possible: true,
    recommendation_source: 'CostExplorer',
  }, spec.provider ?? 'aws-main');
  return parsed;
}

const TERMS: readonly [CommitmentTerm, CommitmentPaymentOption][] = [
  ['ThreeYears', 'AllUpfront'], ['ThreeYears', 'PartialUpfront'], ['ThreeYears', 'NoUpfront'],
  ['OneYear', 'AllUpfront'], ['OneYear', 'PartialUpfront'], ['OneYear', 'NoUpfront'],
];

function computeSp(term: CommitmentTerm, paymentOption: CommitmentPaymentOption, accountScope = 'Payer', eligible = 529.36): unknown {
  return {
    computeSavingsPlans: {
      configuration: { accountScope, term, paymentOption, hourlyCommitment: '0.382' },
      costCalculation: { pricing: { monthlySavingsPlansEligibleCost: eligible, estimatedMonthlyCommitment: 278.86 } },
    },
  };
}

function ec2InstanceSp(term: CommitmentTerm, paymentOption: CommitmentPaymentOption): unknown {
  return {
    ec2InstanceSavingsPlans: {
      configuration: { accountScope: 'Payer', term, paymentOption, hourlyCommitment: '0.081', instanceFamily: 't2', savingsPlansRegion: 'eu-west-1' },
      costCalculation: { pricing: { monthlySavingsPlansEligibleCost: 155.53 } },
    },
  };
}

function ec2Ri(term: CommitmentTerm, paymentOption: CommitmentPaymentOption, offeringClass: string, region: string, eligible: number): unknown {
  return {
    ec2ReservedInstances: {
      configuration: {
        accountScope: 'Payer', service: 'Amazon Elastic Compute Cloud - Compute', term, paymentOption,
        reservedInstancesRegion: region, upfrontCost: '38.0', monthlyRecurringCost: '0.0',
        normalizedUnitsToPurchase: '0.25', numberOfInstancesToPurchase: '1', offeringClass,
        instanceFamily: 't2', instanceType: 't2.nano', currentGeneration: 'true',
        platform: 'Linux/UNIX', tenancy: 'Shared', sizeFlexEligible: true,
      },
      costCalculation: { pricing: { monthlyReservationEligibleCost: eligible } },
    },
  };
}

function rdsRi(term: CommitmentTerm, paymentOption: CommitmentPaymentOption, deploymentOption: string, eligible: number, accountScope = 'Payer'): unknown {
  return {
    rdsReservedInstances: {
      configuration: {
        accountScope, service: 'Amazon Relational Database Service', term, paymentOption,
        reservedInstancesRegion: 'eu-west-1', upfrontCost: '890.0', monthlyRecurringCost: '0.0',
        normalizedUnitsToPurchase: '2.0', numberOfInstancesToPurchase: '2', instanceFamily: 'db.t3',
        instanceType: 'db.t3.micro', sizeFlexEligible: true, currentGeneration: 'true',
        licenseModel: 'No license required', databaseEdition: '', databaseEngine: 'MySQL', deploymentOption,
      },
      costCalculation: { pricing: { monthlyReservationEligibleCost: eligible } },
    },
  };
}

function ec2Instance(type: string): unknown {
  return {
    ec2Instance: {
      configuration: { instance: { type } },
      costCalculation: { usages: [{ usageType: `EU-BoxUsage:${type}`, usageAmount: 336, unit: 'Hrs' }] },
    },
  };
}

function rdsInstance(dbInstanceClass: string, multiAz: boolean): unknown {
  const usage = multiAz ? 'Multi-AZUsage' : 'InstanceUsage';
  return {
    rdsDbInstance: {
      configuration: { instance: { dbInstanceClass } },
      costCalculation: { usages: [{ usageType: `EU-${usage}:${dbInstanceClass}`, usageAmount: 336, unit: 'Hrs' }] },
    },
  };
}

const COMPUTE_SP_SAVINGS = [244.32, 230.79, 209.26, 116.88, 105.55, 80.93];
const COMPUTE_SPS = TERMS.map(([term, payment], i) => rec({
  id: `csp-${String(i)}`, action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', region: 'Global',
  savings: COMPUTE_SP_SAVINGS[i] ?? 0, cost: 529.36, recommended: computeSp(term, payment),
}));

const EC2_INSTANCE_SPS = TERMS.map(([term, payment], i) => rec({
  id: `isp-${String(i)}`, action: 'PurchaseSavingsPlans', type: 'Ec2InstanceSavingsPlans',
  savings: [75.34, 67.2, 59.17, 49.39, 48.3, 39.78][i] ?? 0, cost: 155.53, recommended: ec2InstanceSp(term, payment),
}));

function ec2Ris(region: string, eligible: number, best: number): SavingsRecommendation[] {
  return TERMS.flatMap(([term, payment], i) => (['Standard', 'Convertible'] as const).map((cls, j) => rec({
    id: `ri-${region}-${String(i)}-${cls}`, action: 'PurchaseReservedInstances', type: 'Ec2ReservedInstances', region,
    savings: best - i * 0.1 - j * 0.05, cost: eligible, recommended: ec2Ri(term, payment, cls, region, eligible),
  })));
}

const RIS_EU_WEST_1 = ec2Ris('eu-west-1', 154.41, 83.03);
const RIS_EU_WEST_3 = ec2Ris('eu-west-3', 4.81, 2.67);

// RDS offers no three-year no-upfront reservation.
const RDS_TERMS = TERMS.filter(([term, payment]) => !(term === 'ThreeYears' && payment === 'NoUpfront'));
function rdsRis(deployment: string, eligible: number, savings: readonly number[]): SavingsRecommendation[] {
  return RDS_TERMS.map(([term, payment], i) => rec({
    id: `rds-${deployment}-${String(i)}`, action: 'PurchaseReservedInstances', type: 'RdsReservedInstances',
    savings: savings[i] ?? 0, cost: eligible, recommended: rdsRi(term, payment, deployment, eligible),
  }));
}
const RDS_MULTI_AZ = rdsRis('Multi-AZ', 52.56, [27.84, 27.39, 17.06, 16.29, 14.45]);
const RDS_SINGLE_AZ = rdsRis('Single-AZ', 26.28, [13.89, 13.67, 8.45, 8.23, 7.3]);

const T2_LARGE = 'arn:aws:ec2:eu-west-1:123456789012:instance/i-0d90c6fc9f3e0068c';
const GRAVITON = rec({
  id: 'grav-1', action: 'MigrateToGraviton', type: 'Ec2Instance', arn: T2_LARGE, effort: 'Medium',
  savings: 19.86, cost: 73.58, current: ec2Instance('t2.large'), recommended: ec2Instance('t4g.large'),
});
const UPGRADE = rec({
  id: 'upg-1', action: 'Upgrade', type: 'Ec2Instance', arn: T2_LARGE, effort: 'Medium',
  savings: 7.01, cost: 73.58, current: ec2Instance('t2.large'), recommended: ec2Instance('t3.large'),
});
const FARGATE = [155.09, 153.16, 65.36].map((savings, i) => rec({
  id: `ecs-${String(i)}`, action: 'Rightsize', type: 'EcsService', effort: 'Low',
  arn: `arn:aws:ecs:eu-west-1:123456789012:service/tasks/svc-${String(i)}`, savings, cost: savings + 22,
  current: { ecsService: { configuration: { compute: { vcpu: 2048, memorySizeInMB: 4096 } } } },
}));
const VOLUME = rec({
  id: 'vol-1', action: 'Delete', type: 'EbsVolume', arn: 'arn:aws:ec2:eu-west-1:123456789012:volume/vol-1', effort: 'Low',
  savings: 1.62, cost: 1.62, current: { ebsVolume: { configuration: { storage: { type: 'gp2', sizeInGb: 32 } } } },
});
const DEV_DB = 'arn:aws:rds:eu-west-1:123456789012:db:mysql-dev';
const DB_GRAVITON = rec({
  id: 'rds-grav', action: 'MigrateToGraviton', type: 'RdsDbInstance', arn: DEV_DB, effort: 'Medium',
  savings: 0.73, cost: 26.28, current: rdsInstance('db.t3.small', false), recommended: rdsInstance('db.t4g.small', false),
  currentSummary: 'db.t3.small/Single AZ Deployment',
});

function savings(groups: readonly { readonly monthlySavings: number }[]): number[] {
  return groups.map(g => Math.round(g.monthlySavings * 100) / 100);
}

describe('countSavings — one action per resource', () => {
  it('counts the highest-savings action on a resource and keeps the others as alternatives', () => {
    const result = countSavings([UPGRADE, GRAVITON, VOLUME]);
    expect(result.groups).toHaveLength(2);
    const instance = result.groups.find(g => g.counted.resourceArn === T2_LARGE);
    expect(instance?.kind).toBe('resource');
    expect(instance?.counted.actionType).toBe('MigrateToGraviton');
    expect(instance?.alternatives.map(a => a.actionType)).toEqual(['Upgrade']);
    expect(result.totalMonthlySavings).toBeCloseTo(19.86 + 1.62, 6);
  });

  it('never merges two actions that name no resource', () => {
    const a = rec({ id: 'a', action: 'Rightsize', type: 'Ec2Instance', savings: 5, cost: 10 });
    const b = rec({ id: 'b', action: 'Rightsize', type: 'Ec2Instance', savings: 3, cost: 10 });
    const result = countSavings([a, b]);
    expect(result.groups).toHaveLength(2);
    expect(result.totalMonthlySavings).toBeCloseTo(8, 6);
  });

  it('breaks a savings tie on the recommendation id, whatever the input order', () => {
    const a = rec({ id: 'a', action: 'Upgrade', type: 'Ec2Instance', arn: T2_LARGE, savings: 4, cost: 10 });
    const b = rec({ id: 'b', action: 'Rightsize', type: 'Ec2Instance', arn: T2_LARGE, savings: 4, cost: 10 });
    expect(countSavings([a, b]).groups[0]?.counted.recommendationId).toBe('a');
    expect(countSavings([b, a]).groups[0]?.counted.recommendationId).toBe('a');
  });
});

describe('countSavings — one option per commitment pool', () => {
  it('counts the highest-savings term of a pool by default, as COH does', () => {
    const result = countSavings(COMPUTE_SPS);
    expect(result.groups).toHaveLength(1);
    const pool = result.groups[0];
    expect(pool?.kind).toBe('commitment');
    expect(pool?.counted.recommendationId).toBe('csp-0');
    expect(pool?.alternatives).toHaveLength(5);
    expect(result.totalMonthlySavings).toBeCloseTo(244.32, 6);
  });

  it('counts the preferred term and payment option', () => {
    const oneYearNoUpfront = countSavings(COMPUTE_SPS, { term: 'OneYear', paymentOption: 'NoUpfront' });
    expect(oneYearNoUpfront.groups[0]?.counted.recommendationId).toBe('csp-5');
    expect(oneYearNoUpfront.totalMonthlySavings).toBeCloseTo(80.93, 6);
    // A null field is "highest savings" for that dimension.
    const oneYear = countSavings(COMPUTE_SPS, { term: 'OneYear', paymentOption: null });
    expect(oneYear.groups[0]?.counted.recommendationId).toBe('csp-3');
    const partial = countSavings(COMPUTE_SPS, { term: null, paymentOption: 'PartialUpfront' });
    expect(partial.groups[0]?.counted.recommendationId).toBe('csp-1');
  });

  it('falls back to the preferred term, then to the highest savings, when a pool lacks the preferred option', () => {
    // RDS has no three-year no-upfront reservation: keep the three-year term.
    const threeYearNoUpfront = countSavings(RDS_MULTI_AZ, { term: 'ThreeYears', paymentOption: 'NoUpfront' });
    expect(threeYearNoUpfront.groups[0]?.counted.recommendationId).toBe('rds-Multi-AZ-0');
    const onlyThreeYears = RDS_MULTI_AZ.filter(r => r.commitment?.term === 'ThreeYears');
    const oneYear = countSavings(onlyThreeYears, { term: 'OneYear', paymentOption: 'NoUpfront' });
    expect(oneYear.groups[0]?.counted.recommendationId).toBe('rds-Multi-AZ-0');
  });

  it('counts the best offering class of the preferred term', () => {
    const result = countSavings(RIS_EU_WEST_3, { term: 'OneYear', paymentOption: 'NoUpfront' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.counted.commitment?.offeringClass).toBe('Standard');
    expect(result.groups[0]?.counted.commitment?.term).toBe('OneYear');
    expect(result.groups[0]?.counted.commitment?.paymentOption).toBe('NoUpfront');
  });

  it('folds EC2 Instance Savings Plans and EC2 RIs into the Compute Savings Plan that covers the same usage', () => {
    const result = countSavings([...RIS_EU_WEST_1, ...EC2_INSTANCE_SPS, ...COMPUTE_SPS, ...RIS_EU_WEST_3]);
    expect(result.groups).toHaveLength(1);
    const pool = result.groups[0];
    expect(pool?.counted.recommendationId).toBe('csp-0');
    expect(pool?.alternatives).toHaveLength(5 + 6 + 12 + 12);
    // Highest savings first, whatever pool they come from.
    expect(pool?.alternatives[0]?.recommendationId).toBe('csp-1');
    expect(result.totalMonthlySavings).toBeCloseTo(244.32, 6);
  });

  it('without a Compute Savings Plan, an EC2 Instance Savings Plan hosts the RIs of its family and region only', () => {
    const result = countSavings([...RIS_EU_WEST_1, ...EC2_INSTANCE_SPS, ...RIS_EU_WEST_3]);
    expect(result.groups.map(g => g.counted.commitment?.poolLabel)).toEqual([
      'EC2 Instance Savings Plans · t2 · eu-west-1',
      'EC2 Reserved Instances · t2 · eu-west-3 · Linux/UNIX',
    ]);
    expect(result.groups[0]?.alternatives).toHaveLength(5 + 12);
    expect(result.totalMonthlySavings).toBeCloseTo(75.34 + 2.67, 6);
  });

  it('keeps reservations over different usage apart: one RDS pool per deployment option', () => {
    const result = countSavings([...RDS_MULTI_AZ, ...RDS_SINGLE_AZ]);
    expect(savings(result.groups)).toEqual([27.84, 13.89]);
    expect(result.groups.map(g => g.counted.commitment?.poolLabel)).toEqual([
      'RDS Reserved Instances · db.t3 · eu-west-1 · MySQL · Multi-AZ',
      'RDS Reserved Instances · db.t3 · eu-west-1 · MySQL · Single-AZ',
    ]);
  });

  it('folds a linked-account commitment into the payer-level one of the same export only', () => {
    const linked = rec({
      id: 'linked-csp', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', region: 'Global', account: '210987654321',
      savings: 50, cost: 100, recommended: computeSp('ThreeYears', 'AllUpfront', 'Linked', 100),
    });
    const otherExport = rec({
      id: 'other-csp', provider: 'aws-other', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', region: 'Global',
      savings: 40, cost: 90, recommended: computeSp('ThreeYears', 'AllUpfront', 'Payer', 90),
    });
    const payer = COMPUTE_SPS[0];
    if (payer === undefined) throw new Error('fixture');
    expect(countSavings([linked]).groups).toHaveLength(1);
    const result = countSavings([linked, payer, otherExport]);
    expect(result.groups.map(g => g.counted.recommendationId)).toEqual(['csp-0', 'other-csp']);
    expect(result.groups[0]?.alternatives.map(a => a.recommendationId)).toEqual(['linked-csp']);
  });
});

describe('countSavings — commitments after resource actions', () => {
  it('shrinks a Compute Savings Plan by the eligible spend the counted compute actions remove', () => {
    const result = countSavings([...COMPUTE_SPS, ...FARGATE, GRAVITON, UPGRADE, VOLUME]);
    const plan = result.groups.find(g => g.kind === 'commitment');
    // Fargate rightsizing and the Graviton migration cut the spend the plan
    // was sized on; the Upgrade alternative is not counted, and the EBS
    // volume isn't Compute Savings Plan usage.
    const removed = 155.09 + 153.16 + 65.36 + 19.86;
    expect(plan?.overlapMonthlyCost).toBeCloseTo(removed, 6);
    expect(plan?.overlappingActions).toBe(4);
    expect(plan?.scale).toBeCloseTo((529.36 - removed) / 529.36, 6);
    expect(plan?.monthlySavings).toBeCloseTo(244.32 * (529.36 - removed) / 529.36, 6);
    expect(plan?.monthlyCost).toBeCloseTo(529.36 - removed, 6);
    // COH's own figures stay on the recommendation.
    expect(plan?.counted.monthlySavings).toBeCloseTo(244.32, 6);
    const resources = 155.09 + 153.16 + 65.36 + 19.86 + 1.62;
    expect(result.totalMonthlySavings).toBeCloseTo(resources + 244.32 * (529.36 - removed) / 529.36, 6);
  });

  it('leaves a commitment whole when the overlapping action is not counted', () => {
    const result = countSavings([...COMPUTE_SPS, VOLUME]);
    expect(result.groups.find(g => g.kind === 'commitment')?.scale).toBe(1);
  });

  it('drops a reservation the counted action moves off its instance family', () => {
    const result = countSavings([...RDS_MULTI_AZ, ...RDS_SINGLE_AZ, DB_GRAVITON]);
    const singleAz = result.groups.find(g => g.counted.commitment?.scope.deployment === 'Single-AZ');
    const multiAz = result.groups.find(g => g.counted.commitment?.scope.deployment === 'Multi-AZ');
    // Moving the db.t3 instance to Graviton removes its whole cost from the
    // db.t3 reservation it would have used, not just the Graviton savings.
    expect(singleAz?.overlapMonthlyCost).toBeCloseTo(26.28, 6);
    expect(singleAz?.monthlySavings).toBe(0);
    expect(multiAz?.scale).toBe(1);
    expect(result.totalMonthlySavings).toBeCloseTo(27.84 + 0.73, 6);
  });

  it('never scales below zero and leaves a commitment with no eligible spend whole', () => {
    const small = rec({
      id: 'small-csp', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', region: 'Global',
      savings: 10, cost: 50, recommended: computeSp('ThreeYears', 'AllUpfront', 'Payer', 50),
    });
    const overshoot = countSavings([small, ...FARGATE]);
    expect(overshoot.groups.find(g => g.kind === 'commitment')?.monthlySavings).toBe(0);

    const unsized = rec({
      id: 'unsized', action: 'PurchaseSavingsPlans', type: 'ComputeSavingsPlans', region: 'Global',
      savings: 10, cost: 0, recommended: computeSp('ThreeYears', 'AllUpfront', 'Payer', 0),
    });
    expect(countSavings([unsized, ...FARGATE]).groups.find(g => g.kind === 'commitment')?.scale).toBe(1);
  });
});

describe('countSavings — the demo snapshot', () => {
  it('counts one option per pool and one action per resource over the whole mix', () => {
    const all = [
      ...COMPUTE_SPS, ...EC2_INSTANCE_SPS, ...RIS_EU_WEST_1, ...RIS_EU_WEST_3, ...RDS_MULTI_AZ, ...RDS_SINGLE_AZ,
      ...FARGATE, GRAVITON, UPGRADE, VOLUME, DB_GRAVITON,
    ];
    const listed = all.reduce((s, r) => s + r.monthlySavings, 0);
    const result = countSavings(all, HIGHEST_SAVINGS);
    // 3 commitment pools (compute, two RDS deployments) + 6 resources.
    expect(result.groups).toHaveLength(9);
    expect(result.groups.reduce((n, g) => n + 1 + g.alternatives.length, 0)).toBe(all.length);
    expect(result.totalMonthlySavings).toBeLessThan(listed / 2);
    // Sorted by counted savings, highest first.
    const counted = savings(result.groups);
    expect([...counted].sort((a, b) => b - a)).toEqual(counted);
  });
});
