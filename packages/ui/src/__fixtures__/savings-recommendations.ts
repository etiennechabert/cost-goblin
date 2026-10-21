import type {
  CommitmentDetails,
  CommitmentUsageScope,
  SavingsRecommendation,
} from '@costgoblin/core/browser';
import { asDollars } from '@costgoblin/core/browser';

// Builders for Savings recommendations in UI tests and the mock API. A real
// list comes from `parseSavingsRow` in the main process; these spell out only
// the fields a test is about.

const BASE: SavingsRecommendation = {
  recommendationId: 'rec',
  providerName: 'aws-main',
  accountId: '111111111111',
  accountName: 'Production',
  actionType: 'Rightsize',
  resourceType: 'Ec2Instance',
  summary: '',
  region: 'eu-central-1',
  monthlySavings: asDollars(0),
  monthlyCost: asDollars(0),
  savingsPercentage: 0,
  effort: 'Medium',
  resourceArn: '',
  currentDetails: '',
  recommendedDetails: '',
  currentSummary: '',
  restartNeeded: false,
  rollbackPossible: false,
  recommendationSource: 'ComputeOptimizer',
  commitment: null,
  usage: { family: null, targetFamily: null, deployment: null },
};

/** A rightsizing, deletion, Graviton migration... on one resource. */
export function resourceAction(fields: Partial<SavingsRecommendation>): SavingsRecommendation {
  return { ...BASE, ...fields };
}

export interface CommitmentFields extends Partial<Omit<CommitmentDetails, 'scope'>> {
  readonly pool: string;
  readonly poolLabel: string;
  readonly scope?: Partial<CommitmentUsageScope>;
}

/** A Savings Plan or reservation purchase: `pool` groups its term variants. */
export function commitmentPurchase(fields: Partial<SavingsRecommendation>, commitment: CommitmentFields): SavingsRecommendation {
  const { scope, ...details } = commitment;
  return {
    ...BASE,
    actionType: 'PurchaseSavingsPlans',
    resourceType: 'ComputeSavingsPlans',
    effort: 'VeryLow',
    recommendationSource: 'CostExplorer',
    usage: null,
    ...fields,
    commitment: {
      term: null,
      paymentOption: null,
      offeringClass: '',
      upfrontCost: null,
      eligibleMonthlyCost: fields.monthlyCost ?? asDollars(0),
      coveredBy: [],
      ...details,
      scope: { providerName: 'aws-main', resourceTypes: [], accountId: null, region: null, family: null, deployment: null, ...scope },
    },
  };
}
