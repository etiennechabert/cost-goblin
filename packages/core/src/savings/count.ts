import type { PreferredCommitment } from '../types/api.js';
import { asDollars } from '../types/branded.js';
import type { Dollars } from '../types/branded.js';
import type { CommitmentDetails, CommitmentUsageScope, ResourceUsage, SavingsRecommendation } from '../types/query.js';
import { HIGHEST_SAVINGS } from './labels.js';

// Cost Optimization Hub lists every way to act on a resource and every way to
// buy the same commitment, each with savings computed as if it were the only
// one taken. Adding them up overstates what can be saved — on the demo
// workspace, more than the whole bill. `countSavings` counts what COH's own
// dashboard counts (docs.aws.amazon.com/cost-management/latest/userguide/
// coh-savings-opportunities.html):
//
//  - one action per resource, the one with the highest savings;
//  - one option per commitment pool — the preferred term and payment option,
//    else the highest savings — where a Compute Savings Plan covers the EC2
//    Instance Savings Plans and EC2 RIs over the same usage;
//  - a commitment sized on spend that the counted resource actions cut
//    (rightsizing, Graviton, deletion) shrinks in proportion.
//
// No Node imports: the Savings view recounts in the renderer when the user
// hides an action type or picks a commitment term.

/** One row of the Savings view: a resource or a commitment pool. */
export interface SavingsGroup {
  /** Stable across recounts: the resource, or the pool hosting the group. */
  readonly key: string;
  readonly kind: 'resource' | 'commitment';
  /** The option the totals count. */
  readonly counted: SavingsRecommendation;
  /** The counted option's savings, scaled by `scale` for a commitment. */
  readonly monthlySavings: Dollars;
  /** The counted option's monthly cost, scaled by `scale` for a commitment. */
  readonly monthlyCost: Dollars;
  /** Share of a commitment's eligible spend the counted resource actions
   *  leave; 1 for a resource action. */
  readonly scale: number;
  /** Eligible spend of a commitment that the counted resource actions remove. */
  readonly overlapMonthlyCost: Dollars;
  /** Counted resource actions that remove part of a commitment's spend. */
  readonly overlappingActions: number;
  /** The options left out of the totals, highest savings first. */
  readonly alternatives: readonly SavingsRecommendation[];
}

export interface SavingsCount {
  /** Highest counted savings first. */
  readonly groups: readonly SavingsGroup[];
  readonly totalMonthlySavings: Dollars;
}

/** Deleting or stopping a resource removes all of its spend. */
const WHOLE_RESOURCE_ACTIONS: ReadonlySet<string> = new Set(['Delete', 'Stop']);

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Highest savings first; a tie goes to the lower recommendation id, so the
 *  counted option doesn't depend on the order COH listed them in. */
function bySavings(a: SavingsRecommendation, b: SavingsRecommendation): number {
  return b.monthlySavings - a.monthlySavings || compareCodeUnits(a.recommendationId, b.recommendationId);
}

function best(options: readonly SavingsRecommendation[]): SavingsRecommendation | undefined {
  return options.reduce<SavingsRecommendation | undefined>((top, o) => (top === undefined || bySavings(o, top) < 0 ? o : top), undefined);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** The preferred term and payment option; failing that, the preferred term;
 *  failing that, any option — always the highest savings among them. */
function pickCommitment(options: readonly SavingsRecommendation[], preferred: PreferredCommitment): SavingsRecommendation | undefined {
  const sameTerm = options.filter(o => preferred.term === null || o.commitment?.term === preferred.term);
  const samePayment = sameTerm.filter(o => preferred.paymentOption === null || o.commitment?.paymentOption === preferred.paymentOption);
  if (samePayment.length > 0) return best(samePayment);
  if (sameTerm.length > 0) return best(sameTerm);
  return best(options);
}

/** The broadest present pool covering `pool`, following coverage upward. */
function hostPool(pool: string, pools: ReadonlyMap<string, readonly SavingsRecommendation[]>): string {
  const seen = new Set<string>([pool]);
  const nextHost = (current: string): string | undefined =>
    pools.get(current)?.[0]?.commitment?.coveredBy.find(k => pools.has(k) && !seen.has(k));
  let host = pool;
  let next = nextHost(host);
  while (next !== undefined) {
    seen.add(next);
    host = next;
    next = nextHost(host);
  }
  return host;
}

function inScope(rec: SavingsRecommendation, usage: ResourceUsage, scope: CommitmentUsageScope): boolean {
  return rec.providerName === scope.providerName
    && scope.resourceTypes.includes(rec.resourceType)
    && (scope.accountId === null || scope.accountId === rec.accountId)
    && (scope.region === null || scope.region === rec.region)
    && (scope.family === null || scope.family === usage.family)
    && (scope.deployment === null || scope.deployment === usage.deployment);
}

/** The commitment-eligible spend a counted resource action removes: all of it
 *  when the resource goes away or leaves the instance family the commitment
 *  is bound to (a t2 RI does nothing for a t4g instance), else its savings. */
function removedSpend(rec: SavingsRecommendation, scope: CommitmentUsageScope): number {
  const usage = rec.usage;
  if (usage === null || !inScope(rec, usage, scope)) return 0;
  const cost = Math.max(0, rec.monthlyCost);
  if (WHOLE_RESOURCE_ACTIONS.has(rec.actionType)) return cost;
  const leavesFamily = scope.family !== null && usage.targetFamily !== null && usage.targetFamily !== usage.family;
  if (leavesFamily) return cost;
  return Math.min(cost, Math.max(0, rec.monthlySavings));
}

function resourceGroup(key: string, recs: readonly SavingsRecommendation[]): SavingsGroup | undefined {
  const counted = best(recs);
  if (counted === undefined) return undefined;
  return {
    key,
    kind: 'resource',
    counted,
    monthlySavings: counted.monthlySavings,
    monthlyCost: counted.monthlyCost,
    scale: 1,
    overlapMonthlyCost: asDollars(0),
    overlappingActions: 0,
    alternatives: recs.filter(r => r !== counted).sort(bySavings),
  };
}

function commitmentGroup(
  key: string,
  own: readonly SavingsRecommendation[],
  folded: readonly SavingsRecommendation[],
  preferred: PreferredCommitment,
  resources: readonly SavingsGroup[],
): SavingsGroup | undefined {
  const counted = pickCommitment(own, preferred);
  const details: CommitmentDetails | null | undefined = counted?.commitment;
  if (counted === undefined || details === null || details === undefined) return undefined;
  let overlap = 0;
  let overlapping = 0;
  for (const resource of resources) {
    const removed = removedSpend(resource.counted, details.scope);
    if (removed > 0) {
      overlap += removed;
      overlapping += 1;
    }
  }
  const eligible = details.eligibleMonthlyCost;
  const scale = overlap > 0 && eligible > 0 ? Math.min(1, Math.max(0, (eligible - overlap) / eligible)) : 1;
  return {
    key,
    kind: 'commitment',
    counted,
    monthlySavings: asDollars(counted.monthlySavings * scale),
    monthlyCost: asDollars(counted.monthlyCost * scale),
    scale,
    overlapMonthlyCost: asDollars(overlap),
    overlappingActions: overlapping,
    alternatives: [...own.filter(r => r !== counted), ...folded].sort(bySavings),
  };
}

function byGroupSavings(a: SavingsGroup, b: SavingsGroup): number {
  return b.monthlySavings - a.monthlySavings || compareCodeUnits(a.key, b.key);
}

/** Group recommendations into resources and commitment pools and count one
 *  option of each (see the header). Callers pass only the recommendations
 *  they show: an action type the user hides neither counts nor shrinks a
 *  commitment, and a hidden Savings Plan lets the RIs under it count. */
export function countSavings(recommendations: readonly SavingsRecommendation[], preferred: PreferredCommitment = HIGHEST_SAVINGS): SavingsCount {
  const resources = new Map<string, SavingsRecommendation[]>();
  const pools = new Map<string, SavingsRecommendation[]>();
  recommendations.forEach((rec, index) => {
    if (rec.commitment !== null) {
      push(pools, rec.commitment.pool, rec);
      return;
    }
    // ARNs are unique across accounts and exports; an action naming no
    // resource is a group of its own.
    let key = `row:${String(index)}`;
    if (rec.resourceArn !== '') key = `resource:${rec.resourceArn}`;
    else if (rec.recommendationId !== '') key = `recommendation:${rec.providerName}:${rec.recommendationId}`;
    push(resources, key, rec);
  });

  const resourceGroups: SavingsGroup[] = [];
  for (const [key, recs] of resources) {
    const group = resourceGroup(key, recs);
    if (group !== undefined) resourceGroups.push(group);
  }

  const hosted = new Map<string, { own: SavingsRecommendation[]; folded: SavingsRecommendation[] }>();
  for (const [pool, recs] of pools) {
    const host = hostPool(pool, pools);
    let entry = hosted.get(host);
    if (entry === undefined) {
      entry = { own: [], folded: [] };
      hosted.set(host, entry);
    }
    (host === pool ? entry.own : entry.folded).push(...recs);
  }
  const commitmentGroups: SavingsGroup[] = [];
  for (const [pool, { own, folded }] of hosted) {
    const group = commitmentGroup(`pool:${pool}`, own, folded, preferred, resourceGroups);
    if (group !== undefined) commitmentGroups.push(group);
  }

  const groups = [...commitmentGroups, ...resourceGroups].sort(byGroupSavings);
  return { groups, totalMonthlySavings: asDollars(groups.reduce((sum, g) => sum + g.monthlySavings, 0)) };
}
