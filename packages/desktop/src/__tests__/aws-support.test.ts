import { backfillCase, backfillCaseText } from '@costgoblin/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmAndFileBackfillCase, fileBackfillCase } from '../main/aws-support.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-support', () => {
  const SupportClientMock = vi.fn();
  SupportClientMock.prototype.send = mockSend;
  return { SupportClient: SupportClientMock, CreateCaseCommand: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
});

describe('fileBackfillCase', () => {
  it('files the case in us-east-1 with the chosen profile, saying exactly what backfillCase says', async () => {
    const { SupportClient, CreateCaseCommand } = await import('@aws-sdk/client-support');
    mockSend.mockResolvedValueOnce({ caseId: 'case-123' });

    await expect(fileBackfillCase({ profile: 'billing-admin', tiers: ['daily'] })).resolves.toEqual({ status: 'filed', caseId: 'case-123' });

    expect(SupportClient).toHaveBeenCalledWith({ region: 'us-east-1', profile: 'billing-admin' });
    const supportCase = backfillCase(['daily']);
    expect(CreateCaseCommand).toHaveBeenCalledWith({
      subject: supportCase.subject,
      serviceCode: supportCase.serviceCode,
      categoryCode: supportCase.categoryCode,
      severityCode: 'normal',
      communicationBody: supportCase.body,
      language: 'en',
    });
  });

  it('uses the default credential chain for the default profile', async () => {
    const { SupportClient } = await import('@aws-sdk/client-support');
    mockSend.mockResolvedValueOnce({ caseId: 'case-1' });

    await fileBackfillCase({ profile: 'default', tiers: ['daily', 'hourly'] });

    expect(SupportClient).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  it('reports a support plan without API access as such, so the form can be offered instead', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('AWS Premium Support Subscription is required'), { name: 'SubscriptionRequiredException' }));

    await expect(fileBackfillCase({ profile: 'p', tiers: ['daily'] })).resolves.toEqual({ status: 'subscription-required' });
  });

  it('reports any other failure with its message', async () => {
    mockSend.mockRejectedValueOnce(new Error('User is not authorized to perform: support:CreateCase'));

    await expect(fileBackfillCase({ profile: 'p', tiers: ['daily'] }))
      .resolves.toEqual({ status: 'error', message: 'User is not authorized to perform: support:CreateCase' });
  });

  it('reports a filed case AWS returned no id for as an error rather than a success', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(fileBackfillCase({ profile: 'p', tiers: ['daily'] })).resolves.toMatchObject({ status: 'error' });
  });
});

describe('confirmAndFileBackfillCase', () => {
  it('files nothing unless the user confirms, outside the renderer', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));

    await expect(confirmAndFileBackfillCase({ profile: 'billing-admin', tiers: ['daily'] }, confirm)).resolves.toEqual({ status: 'canceled' });

    expect(confirm).toHaveBeenCalledWith({ profile: 'billing-admin', caseText: backfillCaseText(backfillCase(['daily'])) });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('files the case once the user confirms', async () => {
    mockSend.mockResolvedValueOnce({ caseId: 'case-9' });

    await expect(confirmAndFileBackfillCase({ profile: 'p', tiers: ['daily', 'hourly'] }, () => Promise.resolve(true)))
      .resolves.toEqual({ status: 'filed', caseId: 'case-9' });
  });
});
