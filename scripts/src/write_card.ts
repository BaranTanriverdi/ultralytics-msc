import { load } from "js-yaml";
import type { Operation } from "rfc6902";
import { applyPatch } from "rfc6902";

import { computeSha256, stringifyDeterministic } from "./card/deterministic.js";
import type { CardWriteResult } from "lib/card/types.js";

export function applyPatchAndWriteCard(oldYaml: string | null, patch: Operation[]): CardWriteResult {
  const baseline = oldYaml ? (load(oldYaml) as unknown) ?? {} : {};
  const target = deepClone(baseline);

  const result = applyPatch(target as any, patch as any);
  if (!result) {
    throw new Error("Failed to apply patch: result undefined");
  }

  const firstError = result.find((entry) => entry !== null);
  if (firstError) {
    throw new Error(`Patch failed: ${String(firstError)}`);
  }

  const yaml = stringifyDeterministic(target);
  return {
    newYaml: yaml,
    sha256: computeSha256(yaml)
  };
}

function deepClone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input));
}
