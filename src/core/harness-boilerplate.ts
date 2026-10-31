/**
 * Harness boilerplate detection.
 *
 * Agent harnesses deliver some of their own output through the user-message
 * channel (local slash-command transcripts, injected reminders, background
 * task notices, skill preambles). Importers, qrels extraction, and retrieval
 * guards share this one rule so the same text is classified the same way
 * everywhere.
 */

/**
 * Fixed openings of harness-injected text that was never typed by the user.
 * Literal strings: the harness emits these wrappers verbatim.
 */
export const HARNESS_BOILERPLATE_MARKERS: readonly string[] = [
  '<command-message>', // slash-command expansion
  '<command-name>', // slash-command name
  '<command-args>', // slash-command arguments
  '<local-command-caveat>', // caveat preceding local command output
  '<local-command-stdout>', // local command output
  '<local-command-stderr>', // local command error output
  '<system-reminder>', // injected reminder
  '<task-notification>', // background task completion notice
  '[SYSTEM NOTIFICATION', // notification banner
  '[Request interrupted by user', // interruption record
  '[Image:', // image attachment record; a pasted image in typed text is [Image #N]
  'Base directory for this skill:' // skill preamble
];

/**
 * True when the text opens with a harness marker, after leading whitespace.
 *
 * Position is the whole discriminator: the harness emits a wrapper as the
 * message, so an injection always opens with one, while a marker further in
 * is a person quoting the tooling and stays user text.
 */
export function isHarnessBoilerplate(text: string): boolean {
  const opening = text.trimStart();
  return HARNESS_BOILERPLATE_MARKERS.some((marker) => opening.startsWith(marker));
}
