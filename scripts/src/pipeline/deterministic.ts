import type { Fact, Gate, Anchor } from "lib/card/types.js";

import type { CardSeed } from "../card/seed.js";
import type { Proposal } from "lib/card/types.js";
import type { RepositoryInsights } from "../analysis/repository.js";

export interface DeterministicPipelineInput {
  baselineCard: CardSeed;
  changedFiles: string[];
  insights: RepositoryInsights;
}

export interface DeterministicPipelineResult {
  mutatedCard: CardSeed;
  facts: Fact[];
  coverageNonNull: number;
  lowConfidence: Array<{ jsonPath: string; reason: string }>;
}

export function runDeterministicPipeline(
  input: DeterministicPipelineInput
): DeterministicPipelineResult {
  const { mutatedCard, facts } = buildFactsAndMutations(
    input.baselineCard,
    input.changedFiles,
    input.insights
  );

  const coverageNonNull = computeCoverageDiagnostic(facts);
  const lowConfidence = facts
    .filter((fact) => fact.gate !== "OK")
    .map((fact) => ({ jsonPath: fact.jsonPath, reason: fact.verifierNotes ?? "low confidence" }));

  return {
    mutatedCard,
    facts,
    coverageNonNull,
    lowConfidence
  };
}

function buildFactsAndMutations(
  baseline: CardSeed,
  changedFiles: string[],
  context: RepositoryInsights
): { mutatedCard: CardSeed; facts: Fact[] } {
  const mutated = deepClone(baseline);
  const facts: Fact[] = [];

  const addFact = (fact: DraftFact) => {
    if (!fact.anchors || fact.anchors.length === 0) {
      return;
    }
    applyJsonPointer(mutated, fact.jsonPointer, fact.proposedValue);
    facts.push(toFact(fact, context.headSha));
  };

  addFact({
    jsonPath: "$.meta.title",
    jsonPointer: "/meta/title",
    proposedValue: "ML System Card (GitHub-native, PR-first)",
    currentValue: getValueAtPointer(baseline, "/meta/title"),
    anchors: context.anchorMap["README.md#title"],
    confidence: 0.95,
    sourceKind: "extracted"
  });

  if (context.repositoryUrl) {
    addFact({
      jsonPath: "$.meta.links.repo",
      jsonPointer: "/meta/links/repo",
      proposedValue: context.repositoryUrl,
      currentValue: getValueAtPointer(baseline, "/meta/links/repo"),
      anchors: context.anchorMap["README.md#repo-link"],
      confidence: 0.9,
      sourceKind: "extracted"
    });
  }

  addFact({
    jsonPath: "$.business.useCase",
    jsonPointer: "/business/useCase",
    proposedValue: context.useCase,
    currentValue: getValueAtPointer(baseline, "/business/useCase"),
    anchors: context.anchorMap["README.md#why"],
    confidence: 0.9,
    sourceKind: "extracted"
  });

  addFact({
    jsonPath: "$.business.intendedUse",
    jsonPointer: "/business/intendedUse",
    proposedValue: context.intendedUse,
    currentValue: getValueAtPointer(baseline, "/business/intendedUse"),
    anchors: context.anchorMap["README.md#scope"],
    confidence: 0.85,
    sourceKind: "extracted"
  });

  if (context.nonGoals.length > 0) {
    addFact({
      jsonPath: "$.business.nonGoals",
      jsonPointer: "/business/nonGoals",
      proposedValue: context.nonGoals,
      currentValue: getValueAtPointer(baseline, "/business/nonGoals"),
      anchors: context.anchorMap["README.md#out-of-scope"],
      confidence: 0.85,
      sourceKind: "extracted"
    });
  }

  if (context.outOfScopeUse.length > 0) {
    addFact({
      jsonPath: "$.business.outOfScopeUse",
      jsonPointer: "/business/outOfScopeUse",
      proposedValue: context.outOfScopeUse,
      currentValue: getValueAtPointer(baseline, "/business/outOfScopeUse"),
      anchors: context.anchorMap["README.md#out-of-scope"],
      confidence: 0.8,
      sourceKind: "extracted"
    });
  }

  if (context.userPopulations.length > 0) {
    const stakeholderAnchors = [
      ...(context.anchorMap["README.md#stakeholders"] ?? []),
      ...(context.anchorMap["docs/stakeholders.yaml#titles"] ?? [])
    ];
    addFact({
      jsonPath: "$.business.userPopulations",
      jsonPointer: "/business/userPopulations",
      proposedValue: context.userPopulations,
      currentValue: getValueAtPointer(baseline, "/business/userPopulations"),
      anchors: stakeholderAnchors.length > 0 ? stakeholderAnchors : undefined,
      confidence: 0.8,
      sourceKind: "extracted"
    });
  }

  addFact({
    jsonPath: "$.devInsight.codeOverview.languages",
    jsonPointer: "/devInsight/codeOverview/languages",
    proposedValue: context.languages,
    currentValue: getValueAtPointer(baseline, "/devInsight/codeOverview/languages"),
    anchors: context.anchorMap["CODE#languages"],
    confidence: 0.9,
    sourceKind: "extracted"
  });

  addFact({
    jsonPath: "$.devInsight.codeOverview.entrypoints",
    jsonPointer: "/devInsight/codeOverview/entrypoints",
    proposedValue: context.entrypoints,
    currentValue: getValueAtPointer(baseline, "/devInsight/codeOverview/entrypoints"),
    anchors: context.anchorMap["CODE#entrypoints"],
    confidence: 0.85,
    sourceKind: "extracted"
  });

  if (context.components.length > 0) {
    addFact({
      jsonPath: "$.devInsight.codeOverview.components",
      jsonPointer: "/devInsight/codeOverview/components",
      proposedValue: context.components,
      currentValue: getValueAtPointer(baseline, "/devInsight/codeOverview/components"),
      anchors: context.anchorMap["CODE#components"],
      confidence: 0.8,
      sourceKind: "extracted"
    });
  }

  if (context.dependencyHighlights.length > 0) {
    addFact({
      jsonPath: "$.devInsight.architecture.depsSummary",
      jsonPointer: "/devInsight/architecture/depsSummary",
      proposedValue: context.dependencyHighlights,
      currentValue: getValueAtPointer(baseline, "/devInsight/architecture/depsSummary"),
      anchors: context.anchorMap["CODE#deps"],
      confidence: 0.85,
      sourceKind: "extracted"
    });
  }

  if (context.dataFlow.length > 0) {
    addFact({
      jsonPath: "$.devInsight.architecture.dataFlow",
      jsonPointer: "/devInsight/architecture/dataFlow",
      proposedValue: context.dataFlow,
      currentValue: getValueAtPointer(baseline, "/devInsight/architecture/dataFlow"),
      anchors: context.anchorMap["README.md#workflow"],
      confidence: 0.75,
      sourceKind: "extracted"
    });
  }

  addFact({
    jsonPath: "$.devInsight.qualitySignals.testsPresent",
    jsonPointer: "/devInsight/qualitySignals/testsPresent",
    proposedValue: context.testsPresent,
    currentValue: getValueAtPointer(baseline, "/devInsight/qualitySignals/testsPresent"),
    anchors: context.anchorMap["README.md#commands"],
    confidence: 0.8,
    sourceKind: "extracted"
  });

  if (context.coverageHint) {
    addFact({
      jsonPath: "$.devInsight.qualitySignals.coverageHint",
      jsonPointer: "/devInsight/qualitySignals/coverageHint",
      proposedValue: context.coverageHint,
      currentValue: getValueAtPointer(baseline, "/devInsight/qualitySignals/coverageHint"),
      anchors: context.anchorMap["README.md#commands"],
      confidence: 0.75,
      sourceKind: "extracted"
    });
  }

  addFact({
    jsonPath: "$.mlCore.problem",
    jsonPointer: "/mlCore/problem",
    proposedValue: context.problemSummary,
    currentValue: getValueAtPointer(baseline, "/mlCore/problem"),
    anchors: context.anchorMap["README.md#why"],
    confidence: 0.85,
    sourceKind: "extracted"
  });

  if (context.governancePolicies.length > 0) {
    addFact({
      jsonPath: "$.governance.policies",
      jsonPointer: "/governance/policies",
      proposedValue: context.governancePolicies,
      currentValue: getValueAtPointer(baseline, "/governance/policies"),
      anchors: context.anchorMap["README.md#auto-merge"],
      confidence: 0.75,
      sourceKind: "extracted"
    });
  }

  const changelogFacts = buildChangelogFacts(mutated, baseline, changedFiles, context);
  changelogFacts.facts.forEach((fact) => facts.push(fact));

  return {
    mutatedCard: changelogFacts.card,
    facts
  };
}

export function buildStakeholderNotes(facts: Fact[]): Proposal["notes"] {
  if (facts.length === 0) {
    return {};
  }

  const interestingFacts = facts.filter((fact) =>
    fact.jsonPath.startsWith("$.business") || fact.jsonPath.startsWith("$.devInsight")
  );
  const businessSummary = interestingFacts
    .filter((fact) => fact.jsonPath.startsWith("$.business"))
    .map((fact) => `- ${fact.jsonPath}: updated with confidence ${(fact.confidence * 100).toFixed(0)}%`)
    .join("\n");
  const developerSummary = interestingFacts
    .filter((fact) => fact.jsonPath.startsWith("$.devInsight"))
    .map((fact) => `- ${fact.jsonPath}: anchors ${fact.repoSources.length}`)
    .join("\n");

  const governanceSummary = facts
    .filter((fact) => fact.jsonPath.startsWith("$.provenance"))
    .map((fact) => `- ${fact.jsonPath} (${fact.repoSources.length} anchors)`).join("\n");

  const notes: Proposal["notes"] = {};

  if (businessSummary) {
    notes["product-manager"] = {
      textMd: `Business highlights:\n${businessSummary}`,
      confidence: 0.8
    };
  }

  if (developerSummary) {
    notes["ml-engineer"] = {
      textMd: `Developer view:\n${developerSummary}`,
      confidence: 0.85
    };
  }

  if (governanceSummary) {
    notes["governance-officer"] = {
      textMd: `Provenance updates:\n${governanceSummary}`,
      confidence: 0.75
    };
  }

  return notes;
}

function computeCoverageDiagnostic(facts: Fact[]): number {
  if (facts.length === 0) {
    return 0;
  }
  const anchored = facts.filter((fact) => fact.repoSources.length > 0).length;
  return anchored / facts.length;
}

function buildChangelogFacts(
  mutated: CardSeed,
  baseline: CardSeed,
  changedFiles: string[],
  context: RepositoryInsights
): { card: CardSeed; facts: Fact[] } {
  const changelog: Array<Record<string, unknown>> = Array.isArray(mutated.provenance?.changelog)
    ? [...(mutated.provenance!.changelog as Array<Record<string, unknown>>)]
    : [];

  if (changedFiles.length === 0) {
    return {
      card: {
        ...mutated,
        provenance: { ...(mutated.provenance ?? {}), changelog }
      },
      facts: []
    };
  }

  const entry = {
    date: new Date().toISOString(),
    summary: `ML System Card run ${context.runId} observed ${changedFiles.length} changed files`,
    files: changedFiles.map((path) => ({ path })),
    runId: context.runId,
    headSha: context.headSha
  };

  changelog.push(entry);

  const card = {
    ...mutated,
    provenance: {
      ...(mutated.provenance ?? {}),
      changelog
    }
  };

  const index = changelog.length - 1;
  const confidence = Math.min(0.95, 0.7 + Math.max(0, 5 - changedFiles.length) * 0.05);
  const gate: Gate = confidence >= 0.8 ? "OK" : confidence >= 0.65 ? "Warn" : "Require";

  const fact: Fact = {
    jsonPath: `$.provenance.changelog[${index}]`,
    jsonPointer: `/provenance/changelog/${index}`,
    currentValue: getValueAtPointer(baseline, `/provenance/changelog/${index}`),
    proposedValue: entry,
    source: { kind: "extracted" },
    repoSources: changedFiles.length
      ? changedFiles.map((path) => ({ path, startLine: 1, endLine: 1, commit: context.headSha }))
      : (context.anchorMap["README.md#scope"] ?? []).map((anchor) => ({ ...anchor, commit: context.headSha })),
    confidence,
    gate,
    verifierNotes: gate === "Warn" ? "Review high-change volume" : undefined
  };

  return { card, facts: [fact] };
}

interface DraftFact {
  jsonPath: string;
  jsonPointer: string;
  proposedValue: unknown;
  currentValue: unknown;
  anchors?: Array<Omit<Anchor, "commit">>;
  confidence: number;
  sourceKind: "extracted" | "inferred" | "manual";
  gate?: Gate;
  verifierNotes?: string;
}

function toFact(draft: DraftFact, headSha: string): Fact {
  const gate: Gate = draft.gate
    ? draft.gate
    : draft.confidence >= 0.8
      ? "OK"
      : draft.confidence >= 0.65
        ? "Warn"
        : "Require";

  const repoSources: Anchor[] = (draft.anchors ?? []).map((anchor) => ({
    ...anchor,
    commit: headSha
  }));

  return {
    jsonPath: draft.jsonPath,
    jsonPointer: draft.jsonPointer,
    currentValue: draft.currentValue,
    proposedValue: draft.proposedValue,
    source: { kind: draft.sourceKind },
    repoSources,
    confidence: draft.confidence,
    gate,
    verifierNotes: draft.verifierNotes
  };
}

function applyJsonPointer(target: any, pointer: string, value: unknown): void {
  const tokens = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let cursor: any = target;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const isLast = i === tokens.length - 1;

    if (isLast) {
      cursor[token] = value;
      continue;
    }

    const nextToken = tokens[i + 1];
    const shouldBeArray = /^[0-9]+$/.test(nextToken);

    if (!(token in cursor)) {
      cursor[token] = shouldBeArray ? [] : {};
    }

    if (shouldBeArray && !Array.isArray(cursor[token])) {
      cursor[token] = [];
    }

    cursor = cursor[token];
  }
}

function getValueAtPointer(target: any, pointer: string): unknown {
  const tokens = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: any = target;
  for (const token of tokens) {
    if (cursor === undefined || cursor === null) {
      return undefined;
    }
    cursor = cursor[token];
  }
  return cursor;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
