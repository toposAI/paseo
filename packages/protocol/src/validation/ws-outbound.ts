import type { z } from "zod";
import {
  WSOutboundMessageSchema as WSOutboundZodSchema,
  type WSOutboundMessage,
} from "../messages.js";

type WSOutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: z.ZodError };

interface WSOutboundGeneratedValidator {
  safeParse(input: unknown): WSOutboundValidationResult;
}

// The zod-aot validator is multi-megabyte. Loading it with a dynamic import keeps it out of the
// initial web bundle (a separate chunk fetched in parallel with app start-up) instead of blocking
// the first render on parsing it. Until the chunk arrives, the equivalent plain zod schema
// validates, so no message is ever left unvalidated.
// zod-aot emits runtime JavaScript from WSOutboundMessageSchema but not its TypeScript surface.
// Protocol regression tests cover the patched compiler cases behind this boundary.
let generatedValidator: WSOutboundGeneratedValidator | null = null;
let generatedValidatorLoad: Promise<void> | null = null;

function loadGeneratedValidator(): void {
  generatedValidatorLoad ??= import("../generated/validation/ws-outbound.aot.js").then(
    (module) => {
      generatedValidator = module.WSOutboundMessageSchema as WSOutboundGeneratedValidator;
      return undefined;
    },
    () => {
      // Keep validating with plain zod; allow a later call to retry the chunk fetch.
      generatedValidatorLoad = null;
    },
  );
}

const wsOutboundZodValidator = WSOutboundZodSchema as WSOutboundGeneratedValidator;

loadGeneratedValidator();

export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  return (generatedValidator ?? wsOutboundZodValidator).safeParse(input);
}
