/** Independent rollback switches. Readers and existing tables remain intact. */
export function retrievalRollout() {
  const enabled = (name: string) => !['0', 'false', 'off'].includes((process.env[name] ?? '').toLowerCase());
  return {
    typedTraceWrite: enabled('CML_TYPED_TRACE_WRITE'),
    usefulnessV3Write: enabled('CML_USEFULNESS_V3_WRITE'),
    usefulnessV3Ui: enabled('CML_USEFULNESS_V3_UI')
  };
}
