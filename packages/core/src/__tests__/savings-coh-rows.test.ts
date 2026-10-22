import { describe, expect, it } from 'vitest';
import { parseSavingsRow } from '../savings/coh-rows.js';

// parseSavingsRow turns one row of the Savings query (COH export columns,
// aliased) into a SavingsRecommendation. The details columns are free-form
// JSON from AWS: every shape below comes from a real export, and anything
// else must degrade to "no details" rather than throw.

function row(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    recommendation_id: 'r-1',
    account_id: '123456789012',
    account_name: 'Demo',
    action_type: 'Rightsize',
    current_resource_type: 'Ec2Instance',
    summary: 't3.nano',
    region: 'eu-west-3',
    monthly_savings: 0.51,
    monthly_cost: 4.82,
    savings_pct: 10.6,
    effort: 'Medium',
    resource_arn: 'arn:aws:ec2:eu-west-3:123456789012:instance/i-06ac',
    current_details: '',
    recommended_details: '',
    current_summary: 't2.nano',
    restart_needed: true,
    rollback_possible: true,
    recommendation_source: 'ComputeOptimizer',
    ...overrides,
  };
}

const COMPUTE_SP = JSON.stringify({
  computeSavingsPlans: {
    configuration: { accountScope: 'Payer', term: 'ThreeYears', paymentOption: 'AllUpfront', hourlyCommitment: '0.382' },
    costCalculation: { pricing: { monthlySavingsPlansEligibleCost: 529.358, estimatedMonthlyCommitment: 278.86, estimatedOnDemandCost: 6.182 } },
  },
});

describe('parseSavingsRow — resource actions', () => {
  it('copies the row and reads the instance family before and after the action', () => {
    const rec = parseSavingsRow(row({
      current_details: JSON.stringify({ ec2Instance: { configuration: { instance: { type: 't2.nano' } } } }),
      recommended_details: JSON.stringify({ ec2Instance: { configuration: { instance: { type: 't3.nano' } } } }),
    }), 'aws-main');
    expect(rec).toMatchObject({
      recommendationId: 'r-1',
      providerName: 'aws-main',
      accountId: '123456789012',
      actionType: 'Rightsize',
      resourceType: 'Ec2Instance',
      monthlySavings: 0.51,
      monthlyCost: 4.82,
      effort: 'Medium',
      restartNeeded: true,
      commitment: null,
      usage: { family: 't2', targetFamily: 't3', deployment: null },
    });
  });

  it('reads an RDS instance class and its deployment from the usage type', () => {
    const multiAz = parseSavingsRow(row({
      action_type: 'MigrateToGraviton',
      current_resource_type: 'RdsDbInstance',
      current_details: JSON.stringify({ rdsDbInstance: {
        configuration: { instance: { dbInstanceClass: 'db.t3.small' } },
        costCalculation: { usages: [{ usageType: 'EU-Multi-AZUsage:db.t3.small', usageAmount: 336, unit: 'Hrs' }] },
      } }),
      recommended_details: JSON.stringify({ rdsDbInstance: { configuration: { instance: { dbInstanceClass: 'db.t4g.small' } } } }),
    }), 'aws-main');
    expect(multiAz.usage).toEqual({ family: 'db.t3', targetFamily: 'db.t4g', deployment: 'Multi-AZ' });

    // No usage lines: the summary names the deployment.
    const singleAz = parseSavingsRow(row({
      current_resource_type: 'RdsDbInstance',
      current_details: JSON.stringify({ rdsDbInstance: { configuration: { instance: { dbInstanceClass: 'db.t3.small' } } } }),
      current_summary: 'db.t3.small/Single AZ Deployment',
    }), 'aws-main');
    expect(singleAz.usage?.deployment).toBe('Single-AZ');
  });

  it('knows no family for a resource without an instance type, nor a target for a deletion', () => {
    const rec = parseSavingsRow(row({
      action_type: 'Delete',
      current_resource_type: 'EbsVolume',
      current_details: JSON.stringify({ ebsVolume: { configuration: { storage: { type: 'gp2', sizeInGb: 32 } } } }),
      recommended_details: null,
    }), 'aws-main');
    expect(rec.usage).toEqual({ family: null, targetFamily: null, deployment: null });
  });

  it.each([
    ['unparseable JSON', '{not json'],
    ['a top-level array', '[]'],
    ['a non-object resource entry', JSON.stringify({ ec2Instance: 5 })],
    ['an instance type that is not a string', JSON.stringify({ ec2Instance: { configuration: { instance: { type: 42 } } } })],
    ['an instance type with no family', JSON.stringify({ ec2Instance: { configuration: { instance: { type: 'nano' } } } })],
  ])('reads no family from %s', (_why, details) => {
    expect(parseSavingsRow(row({ current_details: details }), 'aws-main').usage?.family).toBeNull();
  });

  it('maps an effort level AWS did not document to Medium and reads non-numbers as 0', () => {
    const rec = parseSavingsRow(row({ effort: 'Undefined', monthly_savings: null, monthly_cost: '12' }), 'aws-main');
    expect(rec.effort).toBe('Medium');
    expect(rec.monthlySavings).toBe(0);
    expect(rec.monthlyCost).toBe(0);
    expect(parseSavingsRow(row({ monthly_savings: 12n }), 'aws-main').monthlySavings).toBe(12);
  });
});

describe('parseSavingsRow — commitments', () => {
  it('reads a Compute Savings Plan: term, payment, the spend it was sized on and its pool', () => {
    const rec = parseSavingsRow(row({
      action_type: 'PurchaseSavingsPlans',
      current_resource_type: 'ComputeSavingsPlans',
      region: 'Global',
      resource_arn: '',
      monthly_cost: 529.36,
      recommended_details: COMPUTE_SP,
    }), 'aws-main');
    expect(rec.usage).toBeNull();
    expect(rec.commitment).toMatchObject({
      term: 'ThreeYears',
      paymentOption: 'AllUpfront',
      offeringClass: '',
      upfrontCost: null,
      eligibleMonthlyCost: 529.358,
      coveredBy: [],
      poolLabel: 'Compute Savings Plans',
      scope: {
        providerName: 'aws-main',
        resourceTypes: ['Ec2Instance', 'Ec2AutoScalingGroup', 'EcsService', 'LambdaFunction'],
        accountId: null,
        region: null,
        family: null,
        deployment: null,
      },
    });
  });

  it('gives every term and offering class of one reservation the same pool', () => {
    const ri = (term: string, paymentOption: string, offeringClass: string, upfrontCost: string) => parseSavingsRow(row({
      recommendation_id: `${term}-${paymentOption}-${offeringClass}`,
      action_type: 'PurchaseReservedInstances',
      current_resource_type: 'Ec2ReservedInstances',
      region: 'eu-west-1',
      recommended_details: JSON.stringify({ ec2ReservedInstances: {
        configuration: {
          accountScope: 'Payer', term, paymentOption, offeringClass, upfrontCost,
          reservedInstancesRegion: 'eu-west-1', instanceFamily: 't2', instanceType: 't2.nano',
          platform: 'Linux/UNIX', tenancy: 'Shared', sizeFlexEligible: true,
          normalizedUnitsToPurchase: term === 'OneYear' ? '8.0' : '7.5', numberOfInstancesToPurchase: term === 'OneYear' ? '32' : '30',
        },
        costCalculation: { pricing: { monthlyReservationEligibleCost: 154.405 } },
      } }),
    }), 'aws-main').commitment;
    const standard = ri('OneYear', 'AllUpfront', 'Standard', '1152.0');
    const convertible = ri('ThreeYears', 'NoUpfront', 'Convertible', '0.0');
    expect(standard?.pool).toBe(convertible?.pool);
    expect(standard?.offeringClass).toBe('Standard');
    expect(standard?.upfrontCost).toBe(1152);
    expect(convertible?.upfrontCost).toBe(0);
    expect(standard?.poolLabel).toBe('EC2 Reserved Instances · t2 · eu-west-1 · Linux/UNIX');
    expect(standard?.scope).toMatchObject({ resourceTypes: ['Ec2Instance', 'Ec2AutoScalingGroup'], region: 'eu-west-1', family: 't2' });
    // Covered by the payer's Compute Savings Plan and the EC2 Instance
    // Savings Plan of the same family and region.
    expect(standard?.coveredBy).toHaveLength(2);
  });

  it('keeps an instance-size-bound reservation in its own pool and names its tenancy', () => {
    const details = (instanceType: string) => JSON.stringify({ ec2ReservedInstances: { configuration: {
      accountScope: 'Payer', term: 'OneYear', paymentOption: 'NoUpfront', reservedInstancesRegion: 'us-east-1',
      instanceFamily: 'm5', instanceType, platform: 'Windows', tenancy: 'Dedicated', sizeFlexEligible: 'false',
    } } });
    const large = parseSavingsRow(row({ action_type: 'PurchaseReservedInstances', current_resource_type: 'Ec2ReservedInstances', recommended_details: details('m5.large') }), 'aws-main');
    const xlarge = parseSavingsRow(row({ action_type: 'PurchaseReservedInstances', current_resource_type: 'Ec2ReservedInstances', recommended_details: details('m5.xlarge') }), 'aws-main');
    expect(large.commitment?.pool).not.toBe(xlarge.commitment?.pool);
    expect(large.commitment?.poolLabel).toBe('EC2 Reserved Instances · m5.large · us-east-1 · Windows · Dedicated');
  });

  it('puts a linked-account commitment in its account\'s pool, covered by the payer\'s', () => {
    const linked = parseSavingsRow(row({
      action_type: 'PurchaseSavingsPlans',
      current_resource_type: 'ComputeSavingsPlans',
      account_id: '210987654321',
      recommended_details: JSON.stringify({ computeSavingsPlans: { configuration: { accountScope: 'Linked', term: 'OneYear', paymentOption: 'NoUpfront' } } }),
    }), 'aws-main');
    const payer = parseSavingsRow(row({ action_type: 'PurchaseSavingsPlans', current_resource_type: 'ComputeSavingsPlans', recommended_details: COMPUTE_SP }), 'aws-main');
    expect(linked.commitment?.coveredBy).toEqual([payer.commitment?.pool]);
    expect(linked.commitment?.poolLabel).toBe('Compute Savings Plans · account 210987654321');
    expect(linked.commitment?.scope.accountId).toBe('210987654321');
    // Without pricing, the spend it was sized on is the row's monthly cost.
    expect(linked.commitment?.eligibleMonthlyCost).toBe(4.82);
  });

  it('labels other reservation types and the SageMaker Savings Plan generically', () => {
    const cache = parseSavingsRow(row({
      action_type: 'PurchaseReservedInstances',
      current_resource_type: 'ElastiCacheReservedInstances',
      recommended_details: JSON.stringify({ elastiCacheReservedInstances: { configuration: {
        accountScope: 'Payer', term: 'OneYear', paymentOption: 'NoUpfront', reservedInstancesRegion: 'eu-west-1',
        instanceFamily: 'cache.r6g', instanceType: 'cache.r6g.large', sizeFlexEligible: true,
      } } }),
    }), 'aws-main').commitment;
    expect(cache?.poolLabel).toBe('ElastiCache Reserved Instances · cache.r6g · eu-west-1');
    expect(cache?.scope).toMatchObject({ resourceTypes: ['ElastiCacheCluster'], family: 'cache.r6g', region: 'eu-west-1' });

    const sageMaker = parseSavingsRow(row({
      action_type: 'PurchaseSavingsPlans',
      current_resource_type: 'SageMakerSavingsPlans',
      region: 'Global',
      recommended_details: JSON.stringify({ sageMakerSavingsPlans: { configuration: { accountScope: 'Payer', term: 'OneYear', paymentOption: 'AllUpfront' } } }),
    }), 'aws-main').commitment;
    expect(sageMaker?.poolLabel).toBe('SageMaker Savings Plans');
    expect(sageMaker?.scope).toMatchObject({ resourceTypes: ['SageMakerEndpoint'], region: null, family: null });

    const unknown = parseSavingsRow(row({
      action_type: 'PurchaseReservedInstances',
      current_resource_type: 'FutureDbReservedNodes',
      recommended_details: JSON.stringify({ futureDbReservedNodes: { configuration: { term: 'OneYear', paymentOption: 'NoUpfront' } } }),
    }), 'aws-main').commitment;
    expect(unknown?.poolLabel).toBe('Future Db Reserved Nodes · eu-west-3');
    expect(unknown?.scope.resourceTypes).toEqual([]);
  });

  it('still pools a purchase whose details cannot be read, on its type, account and region', () => {
    const a = parseSavingsRow(row({ recommendation_id: 'a', action_type: 'PurchaseSavingsPlans', current_resource_type: 'ComputeSavingsPlans', recommended_details: '{oops' }), 'aws-main');
    const b = parseSavingsRow(row({ recommendation_id: 'b', action_type: 'PurchaseSavingsPlans', current_resource_type: 'ComputeSavingsPlans', recommended_details: '' }), 'aws-main');
    expect(a.commitment).toMatchObject({ term: null, paymentOption: null, eligibleMonthlyCost: 4.82 });
    expect(a.commitment?.pool).toBe(b.commitment?.pool);
  });
});
