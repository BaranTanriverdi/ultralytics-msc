import { promises as fs } from "node:fs";

import type { AnchorsIndex } from "lib/card/types.js";
import fsExtra from "fs-extra";

import {
  ANCHORS_PATH,
  ANCHORS_SCHEMA,
  CARD_PATH,
  DEFAULT_ANCHORS_VERSION
} from "../constants.js";
import {
  computeSha256,
  ensureTrailingNewline,
  normalizeAnchorsIndex,
  stringifyDeterministic
} from "./deterministic.js";

export interface CardSeed {
  ai: Record<string, unknown>;
  business: {
    executiveSummary: string | null;
    useCase: string | null;
    intendedUse: string | null;
    nonGoals: string[];
    kpis: Array<Record<string, unknown>>;
    pilot: Record<string, unknown>;
    outOfScopeUse: string[];
    userPopulations: string[];
    hazardousUseCases: string[];
  };
  devInsight: {
    codeOverview: {
      languages: string[];
      entrypoints: string[];
      components: Array<Record<string, unknown>>;
    };
    architecture: {
      publicApis: Array<Record<string, unknown>>;
      dataFlow: string[];
      depsSummary: string[];
    };
    qualitySignals: {
      testsPresent: boolean | null;
      coverageHint: string | number | null;
      complexityHints: string[];
      todoHotspots: string[];
    };
    runtimePerf: {
      latencyMsP50: number | null;
      latencyMsP95: number | null;
      notes: string | null;
    };
  };
  governance: {
    policies: string[];
    assessments: Array<Record<string, unknown>>;
    riskRegister: Array<Record<string, unknown>>;
    signOffs: Array<Record<string, unknown>>;
  };
  integration: {
    api: Record<string, unknown> | null;
    security: Record<string, unknown> | null;
    errorModel: Array<Record<string, unknown>>;
    idempotency: Record<string, unknown> | null;
    versioningPolicy: Record<string, unknown> | null;
    operationalQualities: Array<Record<string, unknown>>;
    fallbacks: string[];
    observability: Array<Record<string, unknown>>;
    driftSignals: Array<Record<string, unknown>>;
    uxNotes: string | null;
    feedbackChannels: Record<string, unknown> | null;
    incidentReporting: Record<string, unknown> | null;
  };
  meta: {
    title: string | null;
    owners: Array<{ name: string; role: string }>;
    maturity: string | null;
    tags: string[];
    links: Record<string, unknown>;
    language: string | null;
    createdAt: string | null;
    lastUpdated: string | null;
  };
  mlCore: {
    problem: string | null;
    datasets: Array<Record<string, unknown>>;
    features: Array<Record<string, unknown>>;
    baselines: Array<Record<string, unknown>>;
    qualities: Array<Record<string, unknown>>;
    failureModes: Array<Record<string, unknown>>;
    training: Record<string, unknown> | null;
    artifactURIs: Record<string, unknown> | null;
  };
  provenance: {
    changelog: Array<Record<string, unknown>>;
    branch: string | null;
    commit: string | null;
    lastGeneratedAt: string | null;
  };
  stakeholderNotes: Record<string, unknown>;
}

export function createEmptyCard(): CardSeed {
  return {
    ai: {},
    business: {
      executiveSummary: null,
      useCase: null,
      intendedUse: null,
      nonGoals: [],
      kpis: [],
      pilot: {},
      outOfScopeUse: [],
      userPopulations: [],
      hazardousUseCases: []
    },
    devInsight: {
      codeOverview: { languages: [], entrypoints: [], components: [] },
      architecture: { publicApis: [], dataFlow: [], depsSummary: [] },
      qualitySignals: {
        testsPresent: null,
        coverageHint: null,
        complexityHints: [],
        todoHotspots: []
      },
      runtimePerf: { latencyMsP50: null, latencyMsP95: null, notes: null }
    },
    governance: {
      policies: [],
      assessments: [],
      riskRegister: [],
      signOffs: []
    },
    integration: {
      api: null,
      security: null,
      errorModel: [],
      idempotency: null,
      versioningPolicy: null,
      operationalQualities: [],
      fallbacks: [],
      observability: [],
      driftSignals: [],
      uxNotes: null,
      feedbackChannels: null,
      incidentReporting: null
    },
    meta: {
      title: null,
      owners: [],
      maturity: null,
      tags: [],
      links: {},
      language: null,
      createdAt: null,
      lastUpdated: null
    },
    mlCore: {
      problem: null,
      datasets: [],
      features: [],
      baselines: [],
      qualities: [],
      failureModes: [],
      training: null,
      artifactURIs: null
    },
    provenance: { changelog: [], branch: null, commit: null, lastGeneratedAt: new Date().toISOString() },
    stakeholderNotes: {}
  } satisfies CardSeed;
}

export async function ensureSeedArtifacts(): Promise<void> {
  await fsExtra.ensureDir("docs");

  let cardYaml: string | null = null;
  const cardExists = await fsExtra.pathExists(CARD_PATH);
  if (!cardExists) {
    const seedCard = createEmptyCard();
    cardYaml = stringifyDeterministic(seedCard);
    await fs.writeFile(CARD_PATH, cardYaml, "utf8");
  } else {
    cardYaml = await fs.readFile(CARD_PATH, "utf8");
  }

  const anchorsExists = await fsExtra.pathExists(ANCHORS_PATH);
  if (anchorsExists) {
    return;
  }

  const currentYaml = cardYaml ?? (await fs.readFile(CARD_PATH, "utf8"));
  const cardSha = computeSha256(currentYaml);
  const anchors: AnchorsIndex = normalizeAnchorsIndex({
    $schema: ANCHORS_SCHEMA,
    version: DEFAULT_ANCHORS_VERSION,
    cardSha,
    runId: "seed",
    generatedAt: new Date().toISOString(),
    anchorsByPath: {}
  });

  await fs.writeFile(
    ANCHORS_PATH,
    ensureTrailingNewline(JSON.stringify(anchors, null, 2)),
    "utf8"
  );
}
