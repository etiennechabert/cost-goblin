import { backfillCase } from '@costgoblin/core';
import type { BackfillCaseResult, BackfillRequest } from '@costgoblin/core';

// Files the one-click setup's backfill request through the AWS Support API
// (docs/aws-one-click-setup-design.md §5). The API only works on Business,
// Enterprise On-Ramp and Enterprise support plans; on any other plan AWS
// answers SubscriptionRequiredException and the wizard falls back to the
// Support Center form. Kept apart from the handlers (and electron) for tests.

export async function fileBackfillCase(request: BackfillRequest): Promise<BackfillCaseResult> {
  const supportCase = backfillCase(request.tiers);
  try {
    const { SupportClient, CreateCaseCommand } = await import('@aws-sdk/client-support');
    // The Support API is served from us-east-1. 'default' means the default
    // credential chain, as everywhere else the app builds a client.
    const client = new SupportClient({ region: 'us-east-1', ...(request.profile === 'default' ? {} : { profile: request.profile }) });
    const response = await client.send(new CreateCaseCommand({
      subject: supportCase.subject,
      serviceCode: supportCase.serviceCode,
      categoryCode: supportCase.categoryCode,
      // As AWS's Cloud Intelligence Dashboards guide files it.
      severityCode: 'normal',
      communicationBody: supportCase.body,
      language: 'en',
    }));
    if (response.caseId === undefined || response.caseId.length === 0) {
      return { status: 'error', message: 'AWS accepted the request but returned no case id. Check the Support Center.' };
    }
    return { status: 'filed', caseId: response.caseId };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'SubscriptionRequiredException') return { status: 'subscription-required' };
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
