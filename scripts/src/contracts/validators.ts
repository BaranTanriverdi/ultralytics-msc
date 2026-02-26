import { promises as fs } from "node:fs";

import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import type { Decision, Proposal } from "lib/card/types.js";

const PROPOSAL_SCHEMA_PATH = "lib/proposal.schema.json";
const DECISIONS_SCHEMA_PATH = "lib/decisions.schema.json";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

let proposalValidator: ValidateFunction | null = null;
let decisionsValidator: ValidateFunction | null = null;

export async function validateProposal(proposal: Proposal): Promise<string[]> {
  if (!proposalValidator) {
    const schema = await loadSchema(PROPOSAL_SCHEMA_PATH);
    proposalValidator = ajv.compile(schema);
  }
  const valid = proposalValidator!(proposal);
  if (valid) {
    return [];
  }
  return formatErrors(proposalValidator!.errors);
}

export async function validateDecisions(decisions: Decision[]): Promise<string[]> {
  if (!decisionsValidator) {
    const schema = await loadSchema(DECISIONS_SCHEMA_PATH);
    decisionsValidator = ajv.compile(schema);
  }
  const valid = decisionsValidator!(decisions);
  if (valid) {
    return [];
  }
  return formatErrors(decisionsValidator!.errors);
}

async function loadSchema(path: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) {
    return ["Unknown validation error"];
  }
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`);
}
