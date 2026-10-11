import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { SetupWizard } from '../views/setup-wizard.js';

// The one-click AWS setup (docs/aws-one-click-setup-design.md, phase 2): from
// the bucket step, the wizard prepares the CloudFormation template, hands off
// to the console, and writes the config with the stack's paths.

function renderWizard() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <SetupWizard onComplete={vi.fn()} />
    </CostApiProvider>,
  );
  return { api, user };
}

async function openCreateStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByLabelText('Set up from AWS'));
  await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
  await user.click(screen.getByText('default'));
  await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
  await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
  await waitFor(() => { expect(screen.getByText('Create your AWS exports')).toBeDefined(); });
}

function bucketInput(): HTMLInputElement {
  const input = screen.getByLabelText('Bucket name');
  if (!(input instanceof HTMLInputElement)) throw new Error('bucket name is not an input');
  return input;
}

afterEach(cleanup);

describe('SetupWizard — create the AWS exports with CloudFormation', () => {
  it('proposes a unique-looking bucket name', async () => {
    const { user } = renderWizard();
    await openCreateStep(user);

    expect(bucketInput().value).toMatch(/^costgoblin-billing-[a-z0-9]{6}$/);
  });

  it('saves the template with the answers baked in, links to the console, and confirms with the stack’s paths', async () => {
    const { api, user } = renderWizard();
    await openCreateStep(user);

    await user.clear(bucketInput());
    await user.type(bucketInput(), 'acme-billing');
    await user.click(screen.getByLabelText(/Also export hourly data/));
    await user.click(screen.getByRole('button', { name: 'Save the template…' }));

    await waitFor(() => { expect(screen.getByText(/Saved to \/Users\/me\/Downloads\/costgoblin-exports\.yaml/)).toBeDefined(); });
    expect(api.savedExportsTemplates).toEqual([{ bucketName: 'acme-billing', hourly: true, costOptimization: false, serviceRole: true }]);
    const consoleLink = screen.getByRole('link', { name: /Open CloudFormation in us-east-1/ });
    expect(consoleLink.getAttribute('href')).toContain('us-east-1.console.aws.amazon.com/cloudformation');

    await user.click(screen.getByRole('button', { name: 'I’ve created the stack' }));

    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.getByText('s3://acme-billing/')).toBeDefined();
    expect(screen.getByText('costgoblin/daily/costgoblin-daily/')).toBeDefined();
    expect(screen.getByText('costgoblin/hourly/costgoblin-hourly/')).toBeDefined();
  });

  it('asks about the service role only with the Cost Optimization Hub export', async () => {
    const { api, user } = renderWizard();
    await openCreateStep(user);
    expect(screen.queryByLabelText(/already has the Data Exports service role/)).toBeNull();

    await user.click(screen.getByLabelText(/Also export Cost Optimization Hub recommendations/));
    await user.click(screen.getByLabelText(/already has the Data Exports service role/));
    await user.click(screen.getByRole('button', { name: 'Save the template…' }));

    await waitFor(() => { expect(api.savedExportsTemplates).toHaveLength(1); });
    expect(api.savedExportsTemplates[0]).toMatchObject({ costOptimization: true, serviceRole: false });
  });

  it('only continues once the template for the current answers is saved', async () => {
    const { user } = renderWizard();
    await openCreateStep(user);
    const done = () => screen.getByRole('button', { name: 'I’ve created the stack' });
    expect(done().hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save the template…' }));
    await waitFor(() => { expect(done().hasAttribute('disabled')).toBe(false); });

    // A changed answer no longer matches the saved template: the config would
    // point at a bucket the stack never creates.
    await user.type(bucketInput(), 'x');
    expect(done().hasAttribute('disabled')).toBe(true);
  });

  it('refuses a bucket name S3 would refuse, before anything is saved', async () => {
    const { api, user } = renderWizard();
    await openCreateStep(user);

    await user.clear(bucketInput());
    await user.type(bucketInput(), 'Acme Billing');

    expect(screen.getByText(/3 to 63 lowercase letters/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save the template…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'I’ve created the stack' }).hasAttribute('disabled')).toBe(true);
    expect(api.savedExportsTemplates).toEqual([]);
  });

  it('says so when saving fails, and keeps the step', async () => {
    const { api, user } = renderWizard();
    api.saveExportsTemplateResult = { status: 'error', message: 'EACCES: permission denied' };
    await openCreateStep(user);

    await user.click(screen.getByRole('button', { name: 'Save the template…' }));

    await waitFor(() => { expect(screen.getByText(/EACCES: permission denied/)).toBeDefined(); });
    expect(screen.getByText('Create your AWS exports')).toBeDefined();
  });

  it('goes back to the bucket list', async () => {
    const { user } = renderWizard();
    await openCreateStep(user);

    await user.click(screen.getByRole('button', { name: '← Back' }));

    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
  });
});
