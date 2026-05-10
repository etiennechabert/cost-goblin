import { ipcMain } from 'electron';
import {
  logger,
  parseJsonObject,
  asModelName,
  buildPrompt,
  asDimensionId,
  buildCostQuery,
  buildTrendQuery,
  asDollars,
} from '@costgoblin/core';
import type {
  AIPreferences,
  AIModel,
  OllamaStatus,
  InsightParams,
  AIInsight,
  CostQueryParams,
  TrendQueryParams,
  InsightResult,
  QueryContextOptions,
  SavingsResult,
} from '@costgoblin/core';
import type { OllamaManager } from '../ollama-manager.js';
import type { AppContext } from './context.js';
import { prefsPath } from './context.js';
import { buildCostResult, buildTrendResult, resolveAvailablePeriods } from './query-utils.js';

export interface AIHandlerOptions {
  readonly ollamaManager: OllamaManager;
}

export function registerAIHandlers(app: AppContext, options: AIHandlerOptions): void {
  const { ctx } = app;
  const { ollamaManager } = options;

  const aiPrefsPath = () => prefsPath(ctx.dataDir, 'ai-preferences');

  ipcMain.handle('ai:get-preferences', async (): Promise<AIPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await aiPrefsPath(), 'utf-8');
      const parsed = parseJsonObject(raw);
      const enabled = parsed?.['enabled'];
      const defaultModel = parsed?.['defaultModel'];
      const autoGenerateSummaries = parsed?.['autoGenerateSummaries'];
      const showOptimizations = parsed?.['showOptimizations'];

      return {
        enabled: enabled === true,
        defaultModel: typeof defaultModel === 'string' ? asModelName(defaultModel) : null,
        autoGenerateSummaries: autoGenerateSummaries === true,
        showOptimizations: showOptimizations === true || showOptimizations === undefined,
      };
    } catch {
      // File doesn't exist yet — return defaults
    }
    return {
      enabled: false,
      defaultModel: null,
      autoGenerateSummaries: false,
      showOptimizations: true,
    };
  });

  ipcMain.handle('ai:save-preferences', async (_event, prefs: AIPreferences): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(await aiPrefsPath(), JSON.stringify(prefs, null, 2));
    logger.info('ai:preferences-saved', { enabled: prefs.enabled, defaultModel: prefs.defaultModel });
  });

  ipcMain.handle('ai:get-status', async (): Promise<OllamaStatus> => {
    return ollamaManager.checkStatus();
  });

  ipcMain.handle('ai:list-models', async (): Promise<readonly AIModel[]> => {
    return ollamaManager.listModels();
  });

  ipcMain.handle('ai:generate-insight', async (_event, params: InsightParams): Promise<AIInsight> => {
    const startedAt = Date.now();

    // Check if AI is enabled
    const prefs = await (async (): Promise<AIPreferences> => {
      const fs = await import('node:fs/promises');
      try {
        const raw = await fs.readFile(await aiPrefsPath(), 'utf-8');
        const parsed = parseJsonObject(raw);
        const enabled = parsed?.['enabled'];
        const defaultModel = parsed?.['defaultModel'];
        const autoGenerateSummaries = parsed?.['autoGenerateSummaries'];
        const showOptimizations = parsed?.['showOptimizations'];

        return {
          enabled: enabled === true,
          defaultModel: typeof defaultModel === 'string' ? asModelName(defaultModel) : null,
          autoGenerateSummaries: autoGenerateSummaries === true,
          showOptimizations: showOptimizations === true || showOptimizations === undefined,
        };
      } catch {
        return {
          enabled: false,
          defaultModel: null,
          autoGenerateSummaries: false,
          showOptimizations: true,
        };
      }
    })();

    if (!prefs.enabled) {
      throw new Error('AI features are disabled. Enable them in Settings → AI Preferences.');
    }

    // Check Ollama connection
    const status = await ollamaManager.checkStatus();
    if (status.state === 'disconnected') {
      throw new Error(`Ollama is not connected: ${status.error}`);
    }

    // Get model to use
    const models = await ollamaManager.listModels();
    if (models.length === 0) {
      throw new Error('No AI models available. Install a model with: ollama pull llama3.2:3b');
    }

    const model = prefs.defaultModel ?? models[0]?.name ?? asModelName('llama3.2:3b');

    // Fetch query data based on insight type
    const queryData = await fetchQueryData(params, app);

    // Build the prompt
    const prompt = buildPrompt(params, queryData);

    logger.info('ai:generate-insight', {
      type: params.type,
      model,
      promptLength: prompt.length,
    });

    // Generate insight
    const response = await ollamaManager.generate({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 1024,
      },
    });

    // Parse the JSON response
    const result = parseInsightResponse(response.text, params.type);

    const inferenceTimeMs = Date.now() - startedAt;

    return {
      result,
      model,
      generatedAt: new Date().toISOString(),
      inferenceTimeMs,
    };
  });
}

async function fetchQueryData(
  params: InsightParams,
  app: AppContext
): Promise<{
  readonly costResult?: import('@costgoblin/core').CostResult | undefined;
  readonly trendResult?: import('@costgoblin/core').TrendResult | undefined;
  readonly savingsResult?: SavingsResult | undefined;
}> {
  const { ctx, getQueryDimensions, getAccountReverseMap, getOrgAccountsPath, getCostScope, getAvailableColumns, runPreparedQuery, materializedBase } = app;

  switch (params.type) {
    case 'trend-summary': {
      const trendSummaryParams = params;

      // Query costs
      const costQueryParams: CostQueryParams = {
        dateRange: trendSummaryParams.dateRange,
        groupBy: trendSummaryParams.groupBy,
        filters: trendSummaryParams.filters,
        granularity: 'daily',
      };

      const dimensions = await getQueryDimensions();
      const accountReverseMap = await getAccountReverseMap();
      const orgPath = await getOrgAccountsPath();
      const costScope = await getCostScope().catch(() => undefined);
      const availableColumns = await getAvailableColumns('daily');
      const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, 'daily', costQueryParams.dateRange);

      if (empty) {
        const emptyResult = {
          rows: [],
          totalCost: asDollars(0),
          topServices: [],
          dateRange: costQueryParams.dateRange,
        };
        return { costResult: emptyResult, trendResult: { increases: [], savings: [], totalIncrease: asDollars(0), totalSavings: asDollars(0) } };
      }

      const matSource = materializedBase.getSource(costQueryParams.dateRange, 'daily');
      const qcOpts: QueryContextOptions = {
        dataDir: ctx.dataDir,
        dimensions,
        orgAccountsPath: orgPath,
        availablePeriods: available,
        accountReverseMap,
        costScope,
        availableColumns,
        materializedSource: matSource,
      };

      const { sql: costSql, params: costParams } = buildCostQuery(costQueryParams, qcOpts);
      const costRows = await runPreparedQuery(costSql, costParams, matSource !== undefined);
      const costResult = buildCostResult(costRows, costQueryParams.dateRange);

      // Query trends
      const trendQueryParams: TrendQueryParams = {
        dateRange: trendSummaryParams.dateRange,
        groupBy: trendSummaryParams.groupBy,
        filters: trendSummaryParams.filters,
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      };

      // For trends, check if materialized base covers both current and previous period
      const dayMs = 86_400_000;
      const startMs = new Date(`${trendQueryParams.dateRange.start}T00:00:00Z`).getTime();
      const endMs = new Date(`${trendQueryParams.dateRange.end}T00:00:00Z`).getTime();
      const durationDays = Math.round((endMs - startMs) / dayMs) + 1;
      const prevStart = new Date(startMs - durationDays * dayMs).toISOString().slice(0, 10);
      const fullRange = { start: prevStart, end: trendQueryParams.dateRange.end };
      const trendMatSource = materializedBase.getSource(fullRange, 'daily');

      const trendQcOpts: QueryContextOptions = {
        ...qcOpts,
        materializedSource: trendMatSource,
      };

      const { sql: trendSql, params: trendQueryParamsArray } = buildTrendQuery(trendQueryParams, trendQcOpts);
      const trendRows = await runPreparedQuery(trendSql, trendQueryParamsArray, trendMatSource !== undefined);
      const trendResult = buildTrendResult(trendRows, trendQueryParams.deltaThreshold, trendQueryParams.percentThreshold);

      return { costResult, trendResult };
    }

    case 'optimization': {
      const optParams = params;

      // Query costs
      const costQueryParams: CostQueryParams = {
        dateRange: optParams.dateRange,
        groupBy: asDimensionId('service'),
        filters: optParams.filters,
        granularity: 'daily',
      };

      const dimensions = await getQueryDimensions();
      const accountReverseMap = await getAccountReverseMap();
      const orgPath = await getOrgAccountsPath();
      const costScope = await getCostScope().catch(() => undefined);
      const availableColumns = await getAvailableColumns('daily');
      const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, 'daily', costQueryParams.dateRange);

      if (empty) {
        const emptyResult = {
          rows: [],
          totalCost: asDollars(0),
          topServices: [],
          dateRange: costQueryParams.dateRange,
        };
        const emptySavings = {
          recommendations: [],
          totalMonthlySavings: asDollars(0),
        };
        return { costResult: emptyResult, savingsResult: emptySavings };
      }

      const matSource = materializedBase.getSource(costQueryParams.dateRange, 'daily');
      const qcOpts: QueryContextOptions = {
        dataDir: ctx.dataDir,
        dimensions,
        orgAccountsPath: orgPath,
        availablePeriods: available,
        accountReverseMap,
        costScope,
        availableColumns,
        materializedSource: matSource,
      };

      const { sql: optCostSql, params: optCostParams } = buildCostQuery(costQueryParams, qcOpts);
      const optRows = await runPreparedQuery(optCostSql, optCostParams, matSource !== undefined);
      const costResult = buildCostResult(optRows, costQueryParams.dateRange);

      // Query savings - for now return empty as savings query is in a separate handler
      // This would need to import from query-recommendations.ts
      const savingsResult: SavingsResult = {
        recommendations: [],
        totalMonthlySavings: asDollars(0),
      };

      return { costResult, savingsResult };
    }

    case 'conversational': {
      const convParams = params;

      if (convParams.dateRange === undefined) {
        return {};
      }

      // Query costs for context
      const costQueryParams: CostQueryParams = {
        dateRange: convParams.dateRange,
        groupBy: asDimensionId('service'),
        filters: convParams.filters ?? {},
        granularity: 'daily',
      };

      const dimensions = await getQueryDimensions();
      const accountReverseMap = await getAccountReverseMap();
      const orgPath = await getOrgAccountsPath();
      const costScope = await getCostScope().catch(() => undefined);
      const availableColumns = await getAvailableColumns('daily');
      const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, 'daily', costQueryParams.dateRange);

      if (empty) {
        return {};
      }

      const matSource = materializedBase.getSource(costQueryParams.dateRange, 'daily');
      const qcOpts: QueryContextOptions = {
        dataDir: ctx.dataDir,
        dimensions,
        orgAccountsPath: orgPath,
        availablePeriods: available,
        accountReverseMap,
        costScope,
        availableColumns,
        materializedSource: matSource,
      };

      const { sql: convCostSql, params: convCostParams } = buildCostQuery(costQueryParams, qcOpts);
      const convRows = await runPreparedQuery(convCostSql, convCostParams, matSource !== undefined);
      const costResult = buildCostResult(convRows, costQueryParams.dateRange);

      return { costResult };
    }
  }
}

function parseInsightResponse(responseText: string, type: InsightParams['type']): InsightResult {
  // Find JSON in the response (LLMs often add explanatory text around the JSON)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch === null) {
    throw new Error('Failed to parse AI response: no JSON found');
  }

  const parsed: unknown = JSON.parse(jsonMatch[0]);

  switch (type) {
    case 'trend-summary': {
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('summary' in parsed) ||
        !('keyFindings' in parsed) ||
        !('trend' in parsed)
      ) {
        throw new Error('Invalid trend-summary response format');
      }

      const summary = (parsed as { summary: unknown }).summary;
      const keyFindings = (parsed as { keyFindings: unknown }).keyFindings;
      const trend = (parsed as { trend: unknown }).trend;

      if (
        typeof summary !== 'string' ||
        !Array.isArray(keyFindings) ||
        !keyFindings.every((f): f is string => typeof f === 'string') ||
        (trend !== 'increasing' && trend !== 'decreasing' && trend !== 'stable')
      ) {
        throw new Error('Invalid trend-summary response types');
      }

      return {
        type: 'trend-summary',
        summary,
        keyFindings,
        trend,
      };
    }

    case 'optimization': {
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('suggestions' in parsed) ||
        !('totalEstimatedSavings' in parsed)
      ) {
        throw new Error('Invalid optimization response format');
      }

      const suggestions = (parsed as { suggestions: unknown }).suggestions;
      const totalEstimatedSavings = (parsed as { totalEstimatedSavings: unknown })
        .totalEstimatedSavings;

      if (!Array.isArray(suggestions) || typeof totalEstimatedSavings !== 'number') {
        throw new Error('Invalid optimization response types');
      }

      return {
        type: 'optimization',
        suggestions: suggestions.map((s: unknown) => {
          if (
            typeof s !== 'object' ||
            s === null ||
            !('title' in s) ||
            !('description' in s) ||
            !('estimatedSavings' in s) ||
            !('priority' in s)
          ) {
            throw new Error('Invalid suggestion format');
          }

          const title = (s as { title: unknown }).title;
          const description = (s as { description: unknown }).description;
          const estimatedSavings = (s as { estimatedSavings: unknown }).estimatedSavings;
          const priority = (s as { priority: unknown }).priority;

          if (
            typeof title !== 'string' ||
            typeof description !== 'string' ||
            typeof estimatedSavings !== 'number' ||
            (priority !== 'high' && priority !== 'medium' && priority !== 'low')
          ) {
            throw new Error('Invalid suggestion types');
          }

          return {
            title,
            description,
            estimatedSavings,
            priority,
          };
        }),
        totalEstimatedSavings,
      };
    }

    case 'conversational': {
      if (typeof parsed !== 'object' || parsed === null || !('answer' in parsed)) {
        throw new Error('Invalid conversational response format');
      }

      const typedParsed = parsed as Record<string, unknown>;
      const answer = typedParsed['answer'];

      if (typeof answer !== 'string') {
        throw new Error('Invalid conversational response types');
      }

      const supportingDataRaw = typedParsed['supportingData'];
      const supportingData =
        supportingDataRaw !== undefined && Array.isArray(supportingDataRaw)
          ? (supportingDataRaw as unknown[]).filter((d): d is string => typeof d === 'string')
          : undefined;

      return {
        type: 'conversational',
        answer,
        supportingData,
      };
    }
  }
}
