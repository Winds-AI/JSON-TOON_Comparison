# TOON vs JSON Gemini Benchmark Plan

## Objectives
1. Compare Gemini API performance when provided structured data as JSON vs. TOON.
2. Measure token usage (Count Tokens API) and end-to-end latency for each format.
3. Log results in a repeatable script with clear metrics for future experimentation.

## Key Questions
- Does encoding data in TOON reduce input token count compared to JSON?
- How much latency is introduced by converting JSON → TOON before the LLM call?
- Does lower token count yield faster Gemini responses under the same prompt?

## Dependencies and Tooling
- Runtime: Node.js ≥ 20
- API SDK: `@google/genai@^1.29.0`
- TOON encoder: `@byjohann/toon@^0.3.1` (TypeScript-ready ESM package)
- TypeScript support: `typescript`, `tsx`
- Environment variable: `GEMINI_API_KEY`

## Data Strategy
- Maintain mock evaluation data separately in `data/mock-analysis.json` to simplify reuse.
- Structure the dataset to exercise nested objects, arrays, and strings so TOON’s compression benefits surface.

## Script Outline (`src/toon-vs-json.ts`)
1. Load mock data and prompt template.
2. Serialize data to JSON (pretty + compact) and TOON via `encode`.
3. For each format:
   - Call `models.countTokens` to capture token usage.
   - Measure conversion time (JSON → TOON) where applicable.
   - Invoke `models.generateContent` with identical instructions.
   - Record latency and response metadata (`usageMetadata`, `totalLatencyMs`).
4. Aggregate results into a comparison report and emit structured logging (JSON + human-readable table).

## Logging & Reporting
- Use console logging with clear sections:
  - Configuration summary
  - Token counts per format
  - Latency metrics (conversion, API request)
  - Gemini response excerpt
- Emit a final structured JSON blob for downstream processing if desired.

## Next Steps
1. Create TypeScript script following outline above.
2. Add mock dataset file and ensure imports resolve.
3. Document execution instructions (`npm install`, `npm run benchmark`).
4. Extend later with CLI flags (dataset path, model selection) if needed.
