/**
 * Local cross-encoder reranker for the offline ranking evaluation, loaded
 * through the same managed @huggingface/transformers backend the embedder uses.
 * Models are read from (and, with allowDownload, fetched into) the given cache
 * directory only; no fixture or store text leaves the machine.
 */
import type { RerankScorer } from '../src/core/rank-fusion.js';

export interface CrossEncoderPreset {
  model: string;
  /** Parameters, license and on-disk size of the loaded file, for the report. */
  parameters: string;
  license: string;
  fileMb: number;
  loadOptions: Record<string, unknown>;
}

export const CROSS_ENCODER_PRESETS: Record<string, CrossEncoderPreset> = {
  // Multilingual MiniLM distilled on mMARCO (14 languages); the XLM-R
  // vocabulary covers Korean. Small enough for an interactive path.
  'mmarco-minilm': {
    model: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
    parameters: '118M',
    license: 'Apache-2.0',
    fileMb: 119,
    loadOptions: {
      dtype: 'fp32',
      subfolder: 'onnx',
      model_file_name: process.arch === 'arm64' ? 'model_qint8_arm64' : 'model_quint8_avx2'
    }
  },
  // Quality ceiling: the strongest open multilingual reranker with an ONNX
  // export, far too slow for the hook but it bounds what reranking can buy.
  'bge-m3': {
    model: 'onnx-community/bge-reranker-v2-m3-ONNX',
    parameters: '568M',
    license: 'Apache-2.0 (BAAI/bge-reranker-v2-m3)',
    fileMb: 571,
    loadOptions: { dtype: 'q8' }
  }
};

/** Characters kept per document; the tokenizer truncates to 512 tokens anyway. */
const MAX_DOCUMENT_CHARS = 2000;
const BATCH_SIZE = 16;

export interface CrossEncoder {
  preset: CrossEncoderPreset;
  loadMs: number;
  score: RerankScorer;
}

interface TransformersLike {
  env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
  AutoTokenizer: { from_pretrained(model: string): Promise<Tokenizer> };
  AutoModelForSequenceClassification: { from_pretrained(model: string, options: Record<string, unknown>): Promise<Model> };
}
type Tokenizer = (texts: string[], options: Record<string, unknown>) => unknown;
type Model = (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }>;

export async function loadCrossEncoder(
  presetName: string,
  cacheDir: string,
  options: { allowDownload: boolean }
): Promise<CrossEncoder> {
  const preset = CROSS_ENCODER_PRESETS[presetName];
  if (!preset) throw new Error(`unknown reranker ${presetName}; expected one of ${Object.keys(CROSS_ENCODER_PRESETS).join(', ')}`);
  const { normalizeTransformersNamespace, resolveTransformersModuleSpecifier } = await import('../src/extensions/vector/embedder.js');
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  const transformers = normalizeTransformersNamespace(
    await dynamicImport(resolveTransformersModuleSpecifier()) as never
  ) as unknown as TransformersLike;
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = options.allowDownload;
  transformers.env.allowLocalModels = true;

  const startedAt = performance.now();
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(preset.model);
  const model = await transformers.AutoModelForSequenceClassification.from_pretrained(preset.model, preset.loadOptions);
  const loadMs = performance.now() - startedAt;

  const score: RerankScorer = async (query, documents) => {
    const scores: number[] = [];
    for (let start = 0; start < documents.length; start += BATCH_SIZE) {
      const batch = documents.slice(start, start + BATCH_SIZE).map((doc) => doc.slice(0, MAX_DOCUMENT_CHARS));
      const inputs = tokenizer(batch.map(() => query), { text_pair: batch, padding: true, truncation: true, max_length: 512 });
      const { logits } = await model(inputs);
      // One relevance logit per pair.
      const width = logits.dims.at(-1) ?? 1;
      for (let i = 0; i < batch.length; i++) scores.push(Number(logits.data[i * width]));
    }
    return scores;
  };
  return { preset, loadMs, score };
}
