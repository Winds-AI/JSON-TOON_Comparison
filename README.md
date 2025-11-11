# TOON vs JSON Gemini Benchmark

This workspace experiments with TOON (Token-Oriented Object Notation) vs. JSON prompts when calling Gemini models using the Google Gen AI SDK. See `PLAN.md` for experiment scope and deliverables.

## Setup

1. Install dependencies: `npm install`.
2. Create a `.env` file alongside `package.json` with your Gemini key:

   ```bash
   GEMINI_API_KEY=your_api_key_here
   # optionally override the default model
   # GEMINI_MODEL=gemini-2.5-flash
   ```

3. Run the benchmark: `npm run benchmark`.

## Findings

Across 10 benchmark runs (see `reports/`), TOON consistently reduced prompt size and latency:

- **Input tokens sent:** JSON 1,404 → TOON 1,004 (−400 tokens)
- **Prompt tokens in response:** JSON 1,398 → TOON 999 (−399 tokens)
- **Total tokens in response:** JSON 1,658.2 → TOON 1,199.7 (−458.5 tokens)
- **Data prep time:** JSON 0.02 ms → TOON 0.45 ms (+0.43 ms overhead)
- **Gemini response time:** JSON 7,769.05 ms → TOON 7,417.10 ms (−351.95 ms)

TOON adds a small preprocessing cost but still yields lower end-to-end latency thanks to slimmer payloads.

---

## Overall Comparison Summary (10 Benchmark Runs)

**Model Used:** gemini-2.0-flash  
**Date Range:** 2025-11-09T17:51:34.111Z to 2025-11-10T04:54:13.782Z  
**Fastest Format (avg API latency):** TOON

### Token Efficiency (Average)

- **TOON vs JSON:** TOON saved 400 tokens (28.50%)
- **MARKDOWN vs JSON:** MARKDOWN saved 440 tokens (31.30%)
- **MARKDOWN vs TOON:** MARKDOWN saved 40 tokens (4.00%)

### Detailed Average Metrics

| Format | Input tokens sent | Prompt tokens in response | Total tokens in response | Data prep time | Gemini response time |
| --- | --- | --- | --- | --- | --- |
| JSON | 1,404 | 1,398 | 1,667 | 0.1ms | 7533.0ms |
| TOON | 1,004 | 999 | 1,195 | 0.9ms | 6712.0ms |
| MARKDOWN | 964 | 964 | 1,196 | 0.5ms | 7379.7ms |

### Comparison Deltas (Average)

**TOON vs JSON:**
- Token savings: 400 tokens (28.50%)
- API latency delta (JSON - TOON): 820.9ms
- Conversion overhead (TOON - JSON): 0.8ms

**MARKDOWN vs JSON:**
- Token savings: 440 tokens (31.30%)
- API latency delta (JSON - MARKDOWN): 153.2ms
- Conversion overhead (MARKDOWN - JSON): 0.5ms

**MARKDOWN vs TOON:**
- Token savings: 40 tokens (4.00%)
- API latency delta (TOON - MARKDOWN): -667.7ms
- Conversion overhead (MARKDOWN - TOON): -0.4ms

### Key Insights

1. **Token Efficiency:** MARKDOWN provides the best token savings compared to JSON (31.30% reduction).
2. **API Latency:** TOON has the fastest average API response time at 6712.0ms.
3. **Conversion Overhead:** MARKDOWN has lower conversion overhead (0.5ms).

### Metric Definitions

- **Input tokens sent**: Tokens counted before calling Gemini (via the Count Tokens API).
- **Prompt tokens in response**: Tokens Gemini reports as used from the request after processing.
- **Total tokens in response**: Combined prompt and output token count reported by Gemini.
- **Data prep time**: Time spent preparing the payload (JSON formatting, TOON encoding, or Markdown conversion).
- **Gemini response time**: End-to-end latency for `models.generateContent`.

---

*For detailed individual benchmark reports, see `TJM_Reports/` directory. For the complete aggregated summary, see `TJM_Reports/OVERALL_COMPARISON_SUMMARY.md`.*