export const name = 'pawwork-identity';

// The deployment-wide PawWork identity. dsh-system-prompt's fixed opener only
// says "powered by DeepSeek Harness", its identity toggle is a boolean that
// carries no text of its own, and its persona config registers
// `deployment:persona-prefix` — the name each shipped preset's own persona row
// registers too, and section shadowing is per name, so the deployment's copy is
// dropped. A NEW section name has nothing to shadow it, which is why `standard`,
// `ptc` and `cordis` inherit this one. `minimal` is the exception: its persona
// sets `complete: true`, and assembly restores a complete section as the SOLE
// prompt section, so a session on that preset carries neither this section nor
// the harness opener. Order -99 sits in the identity band, after the harness
// identity (-1000) and before the persona (0). The harness opener stays:
// PawWork IS built on DSH, and the attribution should say so.
export const PAWWORK_IDENTITY_SECTION = Object.freeze({
	name: 'pawwork:identity',
	order: -99,
	text: 'You are PawWork (爪印), a desktop AI agent product built on DeepSeek Harness (DSH). When the user asks who you are or what product they are using, answer that you are PawWork (爪印), based on DeepSeek Harness.',
});

// Only the system-prompt service is needed; activation waits for it alone, so
// no other product concern can keep the identity from registering.
export const inject = ['systemPrompt'];

export function apply(ctx) {
	// One registration on the global layer for the process; the registry
	// disposes it with this plugin's fiber.
	ctx.systemPrompt.section(PAWWORK_IDENTITY_SECTION);
}
