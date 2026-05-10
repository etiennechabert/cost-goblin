import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { AIInsightCard } from '../components/ai-insight-card.js';
import { AIChat } from '../components/ai-chat.js';
import type { AIInsight } from '@costgoblin/core/browser';
import { asModelName } from '@costgoblin/core/browser';

afterEach(cleanup);

function renderAIChat(props = {}) {
  const api = new MockCostApi();
  return {
    api,
    ...render(
      <CostApiProvider value={api}>
        <AIChat {...props} />
      </CostApiProvider>,
    ),
  };
}

describe('AIInsightCard', () => {
  it('shows placeholder when insight is null', () => {
    render(<AIInsightCard insight={null} />);
    expect(screen.getByText('AI Insight')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
  });

  it('renders trend summary insight with key findings', () => {
    const insight: AIInsight = {
      result: {
        type: 'trend-summary',
        summary: 'Costs increased by 15% this month, driven primarily by EC2 and RDS spending.',
        keyFindings: [
          'EC2 costs up $2,400 (33%) in ml team',
          'RDS costs stable across all teams',
          'S3 costs decreased 10% due to lifecycle policies',
        ],
        trend: 'increasing',
      },
      model: asModelName('llama3.2:3b'),
      generatedAt: '2026-05-10T12:34:56.789Z',
      inferenceTimeMs: 1234,
    };

    render(<AIInsightCard insight={insight} />);

    expect(screen.getByText('Trend Summary')).toBeDefined();
    expect(screen.getByText('Costs increased by 15% this month, driven primarily by EC2 and RDS spending.')).toBeDefined();
    expect(screen.getByText('Key Findings')).toBeDefined();
    expect(screen.getByText('EC2 costs up $2,400 (33%) in ml team')).toBeDefined();
    expect(screen.getByText('RDS costs stable across all teams')).toBeDefined();
    expect(screen.getByText('S3 costs decreased 10% due to lifecycle policies')).toBeDefined();
    expect(screen.getByText('Model: llama3.2:3b')).toBeDefined();
    expect(screen.getByText('1234ms')).toBeDefined();
  });

  it('renders trend summary with stable trend indicator', () => {
    const insight: AIInsight = {
      result: {
        type: 'trend-summary',
        summary: 'Costs remained stable this period.',
        keyFindings: [],
        trend: 'stable',
      },
      model: asModelName('mistral:7b'),
      generatedAt: '2026-05-10T12:34:56.789Z',
      inferenceTimeMs: 2000,
    };

    render(<AIInsightCard insight={insight} />);

    expect(screen.getByText('Trend Summary')).toBeDefined();
    expect(screen.getByText('Costs remained stable this period.')).toBeDefined();
  });

  it('renders optimization insight with suggestions', () => {
    const insight: AIInsight = {
      result: {
        type: 'optimization',
        suggestions: [
          {
            title: 'Underutilized EC2 instances',
            description: 'Found 12 EC2 instances running at <10% CPU utilization for the past 7 days.',
            estimatedSavings: 3600,
            priority: 'high',
            entities: [],
          },
          {
            title: 'Unattached EBS volumes',
            description: 'Detected 45 unattached EBS volumes that have been idle for 30+ days.',
            estimatedSavings: 1200,
            priority: 'medium',
          },
        ],
        totalEstimatedSavings: 4800,
      },
      model: asModelName('llama3.2:3b'),
      generatedAt: '2026-05-10T12:34:56.789Z',
      inferenceTimeMs: 1500,
    };

    render(<AIInsightCard insight={insight} />);

    expect(screen.getByText('Optimization')).toBeDefined();
    expect(screen.getByText('Total Estimated Savings')).toBeDefined();
    expect(screen.getByText('$4.8k')).toBeDefined();
    expect(screen.getByText('per month')).toBeDefined();
    expect(screen.getByText('Underutilized EC2 instances')).toBeDefined();
    expect(screen.getByText('Found 12 EC2 instances running at <10% CPU utilization for the past 7 days.')).toBeDefined();
    expect(screen.getByText('Save $3.6k/month')).toBeDefined();
    expect(screen.getByText('high')).toBeDefined();
    expect(screen.getByText('Unattached EBS volumes')).toBeDefined();
    expect(screen.getByText('Save $1.2k/month')).toBeDefined();
    expect(screen.getByText('medium')).toBeDefined();
  });

  it('renders conversational insight with answer', () => {
    const insight: AIInsight = {
      result: {
        type: 'conversational',
        answer: 'The platform team spent the most on S3 last month at $6,200, followed by data team at $5,200.',
        supportingData: [
          'Platform team: $6,200 S3 spend',
          'Data team: $5,200 S3 spend',
          'Growth team: $3,100 S3 spend',
        ],
      },
      model: asModelName('llama3.2:3b'),
      generatedAt: '2026-05-10T12:34:56.789Z',
      inferenceTimeMs: 890,
    };

    render(<AIInsightCard insight={insight} />);

    expect(screen.getByText('AI Answer')).toBeDefined();
    expect(screen.getByText('The platform team spent the most on S3 last month at $6,200, followed by data team at $5,200.')).toBeDefined();
    expect(screen.getByText('Supporting Data')).toBeDefined();
    expect(screen.getByText('Platform team: $6,200 S3 spend')).toBeDefined();
    expect(screen.getByText('Data team: $5,200 S3 spend')).toBeDefined();
    expect(screen.getByText('Growth team: $3,100 S3 spend')).toBeDefined();
    expect(screen.getByText('890ms')).toBeDefined();
  });

  it('renders conversational insight without supporting data', () => {
    const insight: AIInsight = {
      result: {
        type: 'conversational',
        answer: 'Based on the data, EC2 costs have been the primary driver of increases.',
      },
      model: asModelName('mistral:7b'),
      generatedAt: '2026-05-10T12:34:56.789Z',
      inferenceTimeMs: 750,
    };

    render(<AIInsightCard insight={insight} />);

    expect(screen.getByText('AI Answer')).toBeDefined();
    expect(screen.getByText('Based on the data, EC2 costs have been the primary driver of increases.')).toBeDefined();
    expect(screen.queryByText('Supporting Data')).toBeNull();
  });
});

describe('AIChat', () => {
  it('renders empty state with placeholder text', () => {
    renderAIChat();
    expect(screen.getByText('AI Cost Assistant')).toBeDefined();
    expect(screen.getByText('Ask me anything about your costs')).toBeDefined();
    expect(screen.getByPlaceholderText('Ask a question about your costs...')).toBeDefined();
  });

  it('renders with initial messages', () => {
    const initialMessages = [
      {
        id: '1',
        role: 'user' as const,
        content: 'What is my total spend?',
        timestamp: '2026-05-10T12:00:00Z',
      },
      {
        id: '2',
        role: 'assistant' as const,
        content: 'Your total spend is $12,500 for the selected period.',
        timestamp: '2026-05-10T12:00:05Z',
      },
    ];

    renderAIChat({ initialMessages });
    expect(screen.getByText('What is my total spend?')).toBeDefined();
    expect(screen.getByText('Your total spend is $12,500 for the selected period.')).toBeDefined();
  });

  it('displays supporting data in assistant messages', () => {
    const initialMessages = [
      {
        id: '1',
        role: 'user' as const,
        content: 'Which team spent the most?',
        timestamp: '2026-05-10T12:00:00Z',
      },
      {
        id: '2',
        role: 'assistant' as const,
        content: 'The platform team spent the most at $6,200.',
        supportingData: ['Platform team: $6,200', 'Data team: $5,200'],
        timestamp: '2026-05-10T12:00:05Z',
      },
    ];

    renderAIChat({ initialMessages });
    expect(screen.getByText('The platform team spent the most at $6,200.')).toBeDefined();
    expect(screen.getByText('Supporting Data')).toBeDefined();
    expect(screen.getByText('Platform team: $6,200')).toBeDefined();
    expect(screen.getByText('Data team: $5,200')).toBeDefined();
  });

  it('handles input change and submit', () => {
    renderAIChat();
    const input = screen.getByPlaceholderText('Ask a question about your costs...');
    const submitButton = screen.getByRole('button');

    // Initially submit button should be disabled
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    // Type a message
    fireEvent.change(input, { target: { value: 'Test question' } });
    expect((input as HTMLInputElement).value).toBe('Test question');
    expect((submitButton as HTMLButtonElement).disabled).toBe(false);

    // Submit the form
    const form = input.closest('form');
    if (form === null) throw new Error('Form not found');
    fireEvent.submit(form);

    // Input should be cleared
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('disables input and submit during loading', async () => {
    renderAIChat();
    const input = screen.getByPlaceholderText('Ask a question about your costs...');
    const form = input.closest('form');
    if (form === null) throw new Error('Form not found');

    // Type and submit
    fireEvent.change(input, { target: { value: 'Test question' } });
    fireEvent.submit(form);

    // Input and button should be disabled during loading
    await waitFor(() => {
      expect((input as HTMLInputElement).disabled).toBe(true);
    });
  });

  it('does not submit empty or whitespace-only messages', () => {
    renderAIChat();
    const input = screen.getByPlaceholderText('Ask a question about your costs...');
    const submitButton = screen.getByRole('button');

    // Empty input
    fireEvent.change(input, { target: { value: '' } });
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    // Whitespace only
    fireEvent.change(input, { target: { value: '   ' } });
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    // Valid input
    fireEvent.change(input, { target: { value: 'Valid question' } });
    expect((submitButton as HTMLButtonElement).disabled).toBe(false);
  });
});
