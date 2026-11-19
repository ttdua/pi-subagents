import { expect, expectTypeOf, it } from "vitest";
import { type LaunchMetadata, type PublishedLaunchIdentity, SUBAGENT_EVENTS } from "#src/service/service";

it("exports PublishedLaunchIdentity by name with optional metadata", () => {
	expectTypeOf<PublishedLaunchIdentity>().toHaveProperty("metadata");
	expectTypeOf<PublishedLaunchIdentity["metadata"]>().toEqualTypeOf<
		LaunchMetadata | undefined
	>();
});

it("SUBAGENT_EVENTS declares UPDATE and ASKED", () => {
	expect(SUBAGENT_EVENTS.UPDATE).toBe("subagents:update");
	expect(SUBAGENT_EVENTS.ASKED).toBe("subagents:asked");
	expect(SUBAGENT_EVENTS.COMPLETED).toBe("subagents:completed");
});
