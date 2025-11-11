import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';

interface FormatMetrics {
  format: 'JSON' | 'TOON' | 'MARKDOWN';
  preflightTokenCount: number;
  responsePromptTokenCount: number;
  responseTotalTokenCount: number;
  conversionMs: number;
  apiLatencyMs: number;
}

interface ComparisonDeltas {
  toonVsJson: {
    tokenSavings: number;
    tokenSavingsPercent: number;
    apiLatencyDeltaMs: number;
    conversionOverheadMs: number;
  };
  markdownVsJson: {
    tokenSavings: number;
    tokenSavingsPercent: number;
    apiLatencyDeltaMs: number;
    conversionOverheadMs: number;
  };
  markdownVsToon: {
    tokenSavings: number;
    tokenSavingsPercent: number;
    apiLatencyDeltaMs: number;
    conversionOverheadMs: number;
  };
}

interface BenchmarkReport {
  timestamp: string;
  model: string;
  formats: FormatMetrics[];
  deltas: ComparisonDeltas;
}

interface AggregatedSummary {
  totalRuns: number;
  model: string;
  dateRange: {
    earliest: string;
    latest: string;
  };
  averageMetrics: {
    JSON: FormatMetrics;
    TOON: FormatMetrics;
    MARKDOWN: FormatMetrics;
  };
  averageDeltas: ComparisonDeltas;
  fastestFormat: string;
}

function parseMs(msString: string): number {
  // Parse strings like "7583.4ms" or "0.0ms"
  const match = msString.match(/([\d.]+)ms/);
  return match ? parseFloat(match[1]) : 0;
}

function parseNumber(numString: string): number {
  // Parse numbers with commas like "1,404"
  return parseInt(numString.replace(/,/g, ''), 10);
}

function parseTokenSavings(line: string): { savings: number; percent: number } {
  // Parse lines like: "- TOON vs JSON: TOON saved 400 tokens (28.5%)"
  const match = line.match(/saved ([\d,]+) tokens \(([\d.]+)%\)/);
  if (match) {
    return {
      savings: parseNumber(match[1]),
      percent: parseFloat(match[2])
    };
  }
  return { savings: 0, percent: 0 };
}

function parseConversionOverhead(line: string): number {
  // Parse lines like: "- TOON conversion overhead: 1.6ms"
  const match = line.match(/([\d.]+)ms/);
  return match ? parseFloat(match[1]) : 0;
}

async function parseMarkdownReport(filePath: string): Promise<BenchmarkReport | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Extract model and timestamp
    const modelMatch = content.match(/\*\*Model used:\*\* (.+)/);
    const timestampMatch = content.match(/\*\*Run timestamp:\*\* (.+)/);
    
    const model = modelMatch ? modelMatch[1].trim() : 'unknown';
    const timestamp = timestampMatch ? timestampMatch[1].trim() : '';

    // Parse metrics table
    const formats: FormatMetrics[] = [];
    let inTable = false;
    
    for (const line of lines) {
      if (line.includes('Format | Input tokens sent')) {
        inTable = true;
        continue;
      }
      
      if (inTable && line.includes('|')) {
        const parts = line.split('|').map(p => p.trim()).filter(p => p);
        if (parts.length >= 6 && parts[0] !== 'Format' && parts[0] !== '---') {
          const format = parts[0] as 'JSON' | 'TOON' | 'MARKDOWN';
          const preflightTokens = parseNumber(parts[1]);
          const promptTokens = parts[2] === 'n/a' ? 0 : parseNumber(parts[2]);
          const totalTokens = parts[3] === 'n/a' ? 0 : parseNumber(parts[3]);
          const conversionMs = parseMs(parts[4]);
          const apiLatencyMs = parseMs(parts[5]);

          formats.push({
            format,
            preflightTokenCount: preflightTokens,
            responsePromptTokenCount: promptTokens,
            responseTotalTokenCount: totalTokens,
            conversionMs,
            apiLatencyMs
          });
        }
      }
      
      // Stop parsing table when we hit the next section
      if (inTable && line.startsWith('##')) {
        break;
      }
    }

    if (formats.length !== 3) {
      console.warn(`Warning: Expected 3 formats but found ${formats.length} in ${filePath}`);
      return null;
    }

    const jsonMetrics = formats.find(f => f.format === 'JSON')!;
    const toonMetrics = formats.find(f => f.format === 'TOON')!;
    const markdownMetrics = formats.find(f => f.format === 'MARKDOWN')!;

    // Parse token savings
    const toonVsJsonLine = lines.find(l => l.includes('TOON vs JSON:'));
    const markdownVsJsonLine = lines.find(l => l.includes('MARKDOWN vs JSON:'));
    const markdownVsToonLine = lines.find(l => l.includes('MARKDOWN vs TOON:'));

    const toonVsJsonSavings = toonVsJsonLine ? parseTokenSavings(toonVsJsonLine) : { savings: 0, percent: 0 };
    const markdownVsJsonSavings = markdownVsJsonLine ? parseTokenSavings(markdownVsJsonLine) : { savings: 0, percent: 0 };
    const markdownVsToonSavings = markdownVsToonLine ? parseTokenSavings(markdownVsToonLine) : { savings: 0, percent: 0 };

    // Parse conversion overhead
    const toonOverheadLine = lines.find(l => l.includes('TOON conversion overhead:'));
    const markdownOverheadLine = lines.find(l => l.includes('MARKDOWN conversion overhead:'));

    const toonOverhead = toonOverheadLine ? parseConversionOverhead(toonOverheadLine) : 0;
    const markdownOverhead = markdownOverheadLine ? parseConversionOverhead(markdownOverheadLine) : 0;

    // Calculate deltas
    const deltas: ComparisonDeltas = {
      toonVsJson: {
        tokenSavings: toonVsJsonSavings.savings,
        tokenSavingsPercent: toonVsJsonSavings.percent,
        apiLatencyDeltaMs: jsonMetrics.apiLatencyMs - toonMetrics.apiLatencyMs,
        conversionOverheadMs: toonOverhead
      },
      markdownVsJson: {
        tokenSavings: markdownVsJsonSavings.savings,
        tokenSavingsPercent: markdownVsJsonSavings.percent,
        apiLatencyDeltaMs: jsonMetrics.apiLatencyMs - markdownMetrics.apiLatencyMs,
        conversionOverheadMs: markdownOverhead
      },
      markdownVsToon: {
        tokenSavings: markdownVsToonSavings.savings,
        tokenSavingsPercent: markdownVsToonSavings.percent,
        apiLatencyDeltaMs: toonMetrics.apiLatencyMs - markdownMetrics.apiLatencyMs,
        conversionOverheadMs: markdownOverhead - toonOverhead
      }
    };

    return {
      timestamp,
      model,
      formats,
      deltas
    };
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error);
    return null;
  }
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

async function aggregateReports(): Promise<void> {
  const reportsDir = path.resolve(process.cwd(), 'TJM_Reports');
  const files = await readdir(reportsDir);
  const markdownFiles = files.filter(f => f.endsWith('.md')).sort();

  console.log(`Found ${markdownFiles.length} benchmark reports`);

  const reports: BenchmarkReport[] = [];
  
  for (const file of markdownFiles) {
    const filePath = path.join(reportsDir, file);
    const report = await parseMarkdownReport(filePath);
    if (report) {
      reports.push(report);
    }
  }

  if (reports.length === 0) {
    console.error('No valid reports found');
    return;
  }

  console.log(`Successfully parsed ${reports.length} reports`);

  // Aggregate metrics
  const totals = {
    JSON: {
      preflightTokenCount: 0,
      responsePromptTokenCount: 0,
      responseTotalTokenCount: 0,
      conversionMs: 0,
      apiLatencyMs: 0,
      count: 0
    },
    TOON: {
      preflightTokenCount: 0,
      responsePromptTokenCount: 0,
      responseTotalTokenCount: 0,
      conversionMs: 0,
      apiLatencyMs: 0,
      count: 0
    },
    MARKDOWN: {
      preflightTokenCount: 0,
      responsePromptTokenCount: 0,
      responseTotalTokenCount: 0,
      conversionMs: 0,
      apiLatencyMs: 0,
      count: 0
    },
    deltas: {
      toonVsJson: {
        tokenSavings: 0,
        tokenSavingsPercent: 0,
        apiLatencyDeltaMs: 0,
        conversionOverheadMs: 0
      },
      markdownVsJson: {
        tokenSavings: 0,
        tokenSavingsPercent: 0,
        apiLatencyDeltaMs: 0,
        conversionOverheadMs: 0
      },
      markdownVsToon: {
        tokenSavings: 0,
        tokenSavingsPercent: 0,
        apiLatencyDeltaMs: 0,
        conversionOverheadMs: 0
      }
    }
  };

  const timestamps: string[] = [];

  for (const report of reports) {
    timestamps.push(report.timestamp);
    
    for (const format of report.formats) {
      const totalsForFormat = totals[format.format];
      totalsForFormat.preflightTokenCount += format.preflightTokenCount;
      totalsForFormat.responsePromptTokenCount += format.responsePromptTokenCount;
      totalsForFormat.responseTotalTokenCount += format.responseTotalTokenCount;
      totalsForFormat.conversionMs += format.conversionMs;
      totalsForFormat.apiLatencyMs += format.apiLatencyMs;
      totalsForFormat.count += 1;
    }

    totals.deltas.toonVsJson.tokenSavings += report.deltas.toonVsJson.tokenSavings;
    totals.deltas.toonVsJson.tokenSavingsPercent += report.deltas.toonVsJson.tokenSavingsPercent;
    totals.deltas.toonVsJson.apiLatencyDeltaMs += report.deltas.toonVsJson.apiLatencyDeltaMs;
    totals.deltas.toonVsJson.conversionOverheadMs += report.deltas.toonVsJson.conversionOverheadMs;

    totals.deltas.markdownVsJson.tokenSavings += report.deltas.markdownVsJson.tokenSavings;
    totals.deltas.markdownVsJson.tokenSavingsPercent += report.deltas.markdownVsJson.tokenSavingsPercent;
    totals.deltas.markdownVsJson.apiLatencyDeltaMs += report.deltas.markdownVsJson.apiLatencyDeltaMs;
    totals.deltas.markdownVsJson.conversionOverheadMs += report.deltas.markdownVsJson.conversionOverheadMs;

    totals.deltas.markdownVsToon.tokenSavings += report.deltas.markdownVsToon.tokenSavings;
    totals.deltas.markdownVsToon.tokenSavingsPercent += report.deltas.markdownVsToon.tokenSavingsPercent;
    totals.deltas.markdownVsToon.apiLatencyDeltaMs += report.deltas.markdownVsToon.apiLatencyDeltaMs;
    totals.deltas.markdownVsToon.conversionOverheadMs += report.deltas.markdownVsToon.conversionOverheadMs;
  }

  const count = reports.length;
  const model = reports[0]?.model || 'unknown';

  // Calculate averages
  const averageMetrics = {
    JSON: {
      format: 'JSON' as const,
      preflightTokenCount: totals.JSON.preflightTokenCount / count,
      responsePromptTokenCount: totals.JSON.responsePromptTokenCount / count,
      responseTotalTokenCount: totals.JSON.responseTotalTokenCount / count,
      conversionMs: totals.JSON.conversionMs / count,
      apiLatencyMs: totals.JSON.apiLatencyMs / count
    },
    TOON: {
      format: 'TOON' as const,
      preflightTokenCount: totals.TOON.preflightTokenCount / count,
      responsePromptTokenCount: totals.TOON.responsePromptTokenCount / count,
      responseTotalTokenCount: totals.TOON.responseTotalTokenCount / count,
      conversionMs: totals.TOON.conversionMs / count,
      apiLatencyMs: totals.TOON.apiLatencyMs / count
    },
    MARKDOWN: {
      format: 'MARKDOWN' as const,
      preflightTokenCount: totals.MARKDOWN.preflightTokenCount / count,
      responsePromptTokenCount: totals.MARKDOWN.responsePromptTokenCount / count,
      responseTotalTokenCount: totals.MARKDOWN.responseTotalTokenCount / count,
      conversionMs: totals.MARKDOWN.conversionMs / count,
      apiLatencyMs: totals.MARKDOWN.apiLatencyMs / count
    }
  };

  const averageDeltas: ComparisonDeltas = {
    toonVsJson: {
      tokenSavings: totals.deltas.toonVsJson.tokenSavings / count,
      tokenSavingsPercent: totals.deltas.toonVsJson.tokenSavingsPercent / count,
      apiLatencyDeltaMs: totals.deltas.toonVsJson.apiLatencyDeltaMs / count,
      conversionOverheadMs: totals.deltas.toonVsJson.conversionOverheadMs / count
    },
    markdownVsJson: {
      tokenSavings: totals.deltas.markdownVsJson.tokenSavings / count,
      tokenSavingsPercent: totals.deltas.markdownVsJson.tokenSavingsPercent / count,
      apiLatencyDeltaMs: totals.deltas.markdownVsJson.apiLatencyDeltaMs / count,
      conversionOverheadMs: totals.deltas.markdownVsJson.conversionOverheadMs / count
    },
    markdownVsToon: {
      tokenSavings: totals.deltas.markdownVsToon.tokenSavings / count,
      tokenSavingsPercent: totals.deltas.markdownVsToon.tokenSavingsPercent / count,
      apiLatencyDeltaMs: totals.deltas.markdownVsToon.apiLatencyDeltaMs / count,
      conversionOverheadMs: totals.deltas.markdownVsToon.conversionOverheadMs / count
    }
  };

  // Determine fastest format
  const latencies = [
    { format: 'JSON', latency: averageMetrics.JSON.apiLatencyMs },
    { format: 'TOON', latency: averageMetrics.TOON.apiLatencyMs },
    { format: 'MARKDOWN', latency: averageMetrics.MARKDOWN.apiLatencyMs }
  ];
  latencies.sort((a, b) => a.latency - b.latency);
  const fastestFormat = latencies[0].format;

  timestamps.sort();
  const summary: AggregatedSummary = {
    totalRuns: count,
    model,
    dateRange: {
      earliest: timestamps[0],
      latest: timestamps[timestamps.length - 1]
    },
    averageMetrics,
    averageDeltas,
    fastestFormat
  };

  // Generate markdown report
  const markdown = generateSummaryReport(summary);
  const outputPath = path.join(reportsDir, 'OVERALL_COMPARISON_SUMMARY.md');
  await writeFile(outputPath, markdown, 'utf-8');

  // Also save JSON
  const jsonPath = path.join(reportsDir, 'OVERALL_COMPARISON_SUMMARY.json');
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\n✅ Overall Comparison Summary generated:`);
  console.log(`   - Markdown: ${outputPath}`);
  console.log(`   - JSON: ${jsonPath}`);

  // Print summary to console
  console.log('\n' + '='.repeat(80));
  console.log('OVERALL COMPARISON SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nTotal Runs: ${count}`);
  console.log(`Model: ${model}`);
  console.log(`Date Range: ${summary.dateRange.earliest} to ${summary.dateRange.latest}`);
  console.log(`\nFastest Format (avg API latency): ${fastestFormat}`);

  console.log('\n📊 Average Metrics by Format:');
  console.table([
    {
      Format: 'JSON',
      'Input Tokens': Math.round(averageMetrics.JSON.preflightTokenCount).toLocaleString(),
      'Prompt Tokens': Math.round(averageMetrics.JSON.responsePromptTokenCount).toLocaleString(),
      'Total Tokens': Math.round(averageMetrics.JSON.responseTotalTokenCount).toLocaleString(),
      'Conversion Time': formatMs(averageMetrics.JSON.conversionMs),
      'API Latency': formatMs(averageMetrics.JSON.apiLatencyMs)
    },
    {
      Format: 'TOON',
      'Input Tokens': Math.round(averageMetrics.TOON.preflightTokenCount).toLocaleString(),
      'Prompt Tokens': Math.round(averageMetrics.TOON.responsePromptTokenCount).toLocaleString(),
      'Total Tokens': Math.round(averageMetrics.TOON.responseTotalTokenCount).toLocaleString(),
      'Conversion Time': formatMs(averageMetrics.TOON.conversionMs),
      'API Latency': formatMs(averageMetrics.TOON.apiLatencyMs)
    },
    {
      Format: 'MARKDOWN',
      'Input Tokens': Math.round(averageMetrics.MARKDOWN.preflightTokenCount).toLocaleString(),
      'Prompt Tokens': Math.round(averageMetrics.MARKDOWN.responsePromptTokenCount).toLocaleString(),
      'Total Tokens': Math.round(averageMetrics.MARKDOWN.responseTotalTokenCount).toLocaleString(),
      'Conversion Time': formatMs(averageMetrics.MARKDOWN.conversionMs),
      'API Latency': formatMs(averageMetrics.MARKDOWN.apiLatencyMs)
    }
  ]);

  console.log('\n💾 Token Savings (Average):');
  console.log(`  TOON vs JSON: ${Math.round(averageDeltas.toonVsJson.tokenSavings).toLocaleString()} tokens (${averageDeltas.toonVsJson.tokenSavingsPercent.toFixed(2)}%)`);
  console.log(`  MARKDOWN vs JSON: ${Math.round(averageDeltas.markdownVsJson.tokenSavings).toLocaleString()} tokens (${averageDeltas.markdownVsJson.tokenSavingsPercent.toFixed(2)}%)`);
  console.log(`  MARKDOWN vs TOON: ${Math.round(averageDeltas.markdownVsToon.tokenSavings).toLocaleString()} tokens (${averageDeltas.markdownVsToon.tokenSavingsPercent.toFixed(2)}%)`);

  console.log('\n⚡ Latency Comparisons (Average):');
  console.log(`  API latency delta (JSON - TOON): ${formatMs(averageDeltas.toonVsJson.apiLatencyDeltaMs)}`);
  console.log(`  API latency delta (JSON - MARKDOWN): ${formatMs(averageDeltas.markdownVsJson.apiLatencyDeltaMs)}`);
  console.log(`  API latency delta (TOON - MARKDOWN): ${formatMs(averageDeltas.markdownVsToon.apiLatencyDeltaMs)}`);

  console.log('\n🔧 Conversion Overhead (Average):');
  console.log(`  TOON conversion overhead: ${formatMs(averageDeltas.toonVsJson.conversionOverheadMs)}`);
  console.log(`  MARKDOWN conversion overhead: ${formatMs(averageDeltas.markdownVsJson.conversionOverheadMs)}`);
}

function generateSummaryReport(summary: AggregatedSummary): string {
  const { averageMetrics, averageDeltas } = summary;

  return `# Overall Comparison Summary

- **Total Benchmark Runs:** ${summary.totalRuns}
- **Model Used:** ${summary.model}
- **Date Range:** ${summary.dateRange.earliest} to ${summary.dateRange.latest}
- **Fastest Format (avg API latency):** ${summary.fastestFormat}

## Executive Summary

### Token Efficiency (Average)

- **TOON vs JSON:** ${averageDeltas.toonVsJson.tokenSavings > 0 ? 'TOON' : 'JSON'} saved ${Math.abs(Math.round(averageDeltas.toonVsJson.tokenSavings)).toLocaleString()} tokens (${averageDeltas.toonVsJson.tokenSavingsPercent.toFixed(2)}%)
- **MARKDOWN vs JSON:** ${averageDeltas.markdownVsJson.tokenSavings > 0 ? 'MARKDOWN' : 'JSON'} saved ${Math.abs(Math.round(averageDeltas.markdownVsJson.tokenSavings)).toLocaleString()} tokens (${averageDeltas.markdownVsJson.tokenSavingsPercent.toFixed(2)}%)
- **MARKDOWN vs TOON:** ${averageDeltas.markdownVsToon.tokenSavings > 0 ? 'MARKDOWN' : 'TOON'} saved ${Math.abs(Math.round(averageDeltas.markdownVsToon.tokenSavings)).toLocaleString()} tokens (${averageDeltas.markdownVsToon.tokenSavingsPercent.toFixed(2)}%)

### Latency (Average)

- **Fastest format:** ${summary.fastestFormat}
- **TOON conversion overhead:** ${formatMs(averageDeltas.toonVsJson.conversionOverheadMs)}
- **MARKDOWN conversion overhead:** ${formatMs(averageDeltas.markdownVsJson.conversionOverheadMs)}

## Detailed Average Metrics

Format | Input tokens sent | Prompt tokens in response | Total tokens in response | Data prep time | Gemini response time
--- | --- | --- | --- | --- | ---
JSON | ${Math.round(averageMetrics.JSON.preflightTokenCount).toLocaleString()} | ${Math.round(averageMetrics.JSON.responsePromptTokenCount).toLocaleString()} | ${Math.round(averageMetrics.JSON.responseTotalTokenCount).toLocaleString()} | ${formatMs(averageMetrics.JSON.conversionMs)} | ${formatMs(averageMetrics.JSON.apiLatencyMs)}
TOON | ${Math.round(averageMetrics.TOON.preflightTokenCount).toLocaleString()} | ${Math.round(averageMetrics.TOON.responsePromptTokenCount).toLocaleString()} | ${Math.round(averageMetrics.TOON.responseTotalTokenCount).toLocaleString()} | ${formatMs(averageMetrics.TOON.conversionMs)} | ${formatMs(averageMetrics.TOON.apiLatencyMs)}
MARKDOWN | ${Math.round(averageMetrics.MARKDOWN.preflightTokenCount).toLocaleString()} | ${Math.round(averageMetrics.MARKDOWN.responsePromptTokenCount).toLocaleString()} | ${Math.round(averageMetrics.MARKDOWN.responseTotalTokenCount).toLocaleString()} | ${formatMs(averageMetrics.MARKDOWN.conversionMs)} | ${formatMs(averageMetrics.MARKDOWN.apiLatencyMs)}

## Comparison Deltas (Average)

### TOON vs JSON
- **Token savings:** ${Math.round(averageDeltas.toonVsJson.tokenSavings).toLocaleString()} tokens (${averageDeltas.toonVsJson.tokenSavingsPercent.toFixed(2)}%)
- **API latency delta (JSON - TOON):** ${formatMs(averageDeltas.toonVsJson.apiLatencyDeltaMs)}
- **Conversion overhead (TOON - JSON):** ${formatMs(averageDeltas.toonVsJson.conversionOverheadMs)}

### MARKDOWN vs JSON
- **Token savings:** ${Math.round(averageDeltas.markdownVsJson.tokenSavings).toLocaleString()} tokens (${averageDeltas.markdownVsJson.tokenSavingsPercent.toFixed(2)}%)
- **API latency delta (JSON - MARKDOWN):** ${formatMs(averageDeltas.markdownVsJson.apiLatencyDeltaMs)}
- **Conversion overhead (MARKDOWN - JSON):** ${formatMs(averageDeltas.markdownVsJson.conversionOverheadMs)}

### MARKDOWN vs TOON
- **Token savings:** ${Math.round(averageDeltas.markdownVsToon.tokenSavings).toLocaleString()} tokens (${averageDeltas.markdownVsToon.tokenSavingsPercent.toFixed(2)}%)
- **API latency delta (TOON - MARKDOWN):** ${formatMs(averageDeltas.markdownVsToon.apiLatencyDeltaMs)}
- **Conversion overhead (MARKDOWN - TOON):** ${formatMs(averageDeltas.markdownVsToon.conversionOverheadMs)}

## Key Insights

1. **Token Efficiency:** ${averageDeltas.toonVsJson.tokenSavingsPercent > averageDeltas.markdownVsJson.tokenSavingsPercent ? 'TOON' : 'MARKDOWN'} provides the best token savings compared to JSON (${Math.max(averageDeltas.toonVsJson.tokenSavingsPercent, averageDeltas.markdownVsJson.tokenSavingsPercent).toFixed(2)}% reduction).

2. **API Latency:** ${summary.fastestFormat} has the fastest average API response time at ${formatMs(averageMetrics[summary.fastestFormat as keyof typeof averageMetrics].apiLatencyMs)}.

3. **Conversion Overhead:** ${averageDeltas.toonVsJson.conversionOverheadMs < averageDeltas.markdownVsJson.conversionOverheadMs ? 'TOON' : 'MARKDOWN'} has lower conversion overhead (${formatMs(Math.min(averageDeltas.toonVsJson.conversionOverheadMs, averageDeltas.markdownVsJson.conversionOverheadMs))}).

## Metric Definitions

- **Input tokens sent**: Tokens counted before calling Gemini (via the Count Tokens API).
- **Prompt tokens in response**: Tokens Gemini reports as used from the request after processing.
- **Total tokens in response**: Combined prompt and output token count reported by Gemini.
- **Data prep time**: Time spent preparing the payload (JSON formatting, TOON encoding, or Markdown conversion).
- **Gemini response time**: End-to-end latency for \`models.generateContent\`.
`;
}

aggregateReports().catch((error) => {
  console.error('Failed to aggregate reports:', error);
  process.exitCode = 1;
});

