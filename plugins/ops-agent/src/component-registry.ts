/**
 * The open-ended component, probe and SOP registry.
 *
 * Components, dependencies, checks and SOPs are DATA. A new component kind, a
 * new probe, a new SOP: none of them requires a TypeScript edit, which is what
 * acceptance criterion 14 asks for and what the fixture tests prove by loading
 * a component this package has never heard of.
 *
 * Installation is ATOMIC and per bundle. A bad bundle fails only its own
 * tenant: nothing is installed from it, and every already-installed healthy
 * component stays exactly as it was. A loader that half-applied a bundle would
 * leave the daemon describing a topology that never existed.
 * @module dsh-plugin-ops-agent/component-registry
 */
import {
  CheckRegistry,
  CheckDefinitionSchema,
  ComponentSpecSchema,
  DependencyEdgeSchema,
  DependencyGraph,
  SopDefinitionSchema,
  certifySop,
  type CheckDefinition,
  type AuthorityManifestEntry,
  type ComponentSpec,
  type DependencyEdge,
  type Observation,
  type SopAuthority,
  type SopDefinition,
} from "@helium/core";
import {
  resolveSopAuthority,
  type AuthoritySource,
} from "./authority-manifest-loader.js";

export interface OpsBundle {
  /** Opaque tenant name; a bundle fails or succeeds as a whole. */
  tenantId: string;
  components: unknown[];
  edges?: unknown[];
  checks?: unknown[];
  sops?: unknown[];
}

export interface LoadedSop {
  definition: SopDefinition;
  /** The authority actually granted -- never above the file's own claim. */
  authority: SopAuthority;
  authorityManifestEntry?: AuthorityManifestEntry;
  authorityDowngradeReason?: string;
  certified: boolean;
  certificationReasons: string[];
}

export interface RegistryLimits {
  maxComponents: number;
  maxSops: number;
  maxChecks: number;
}

const DEFAULT_LIMITS: RegistryLimits = {
  maxComponents: 200,
  maxSops: 200,
  maxChecks: 500,
};

export class ComponentRegistry {
  readonly #components = new Map<string, ComponentSpec>();
  readonly #edges: DependencyEdge[] = [];
  readonly #sops = new Map<string, LoadedSop>();
  readonly #checks = new Map<string, CheckDefinition>();
  readonly #observations: Observation[] = [];
  readonly #tenantOf = new Map<string, string>();

  constructor(
    private readonly deps: {
      authority: AuthoritySource;
      registeredProbeIds: readonly string[];
      now: () => Date;
      limits?: Partial<RegistryLimits>;
    },
  ) {}

  #limits(): RegistryLimits {
    return { ...DEFAULT_LIMITS, ...this.deps.limits };
  }

  /**
   * Install one bundle atomically.
   *
   * @returns an effect-scoped disposer that removes exactly what this bundle
   * added, leaving every other tenant untouched.
   * @throws when the bundle is invalid. Nothing from it is installed.
   */
  install(bundle: OpsBundle): () => void {
    const limits = this.#limits();

    const components = (bundle.components ?? []).map((c) =>
      ComponentSpecSchema.parse(c),
    );
    const edges = (bundle.edges ?? []).map((e) => DependencyEdgeSchema.parse(e));
    const checks = (bundle.checks ?? []).map((check) =>
      CheckDefinitionSchema.parse(check),
    );
    const sops = (bundle.sops ?? []).map((s) => SopDefinitionSchema.parse(s));
    const incomingComponentIds = new Set(components.map((component) => component.id));
    const incomingCheckIds = new Set(checks.map((check) => check.id));

    // A disposer may remove only this bundle. Cross-bundle references would
    // therefore become dangling the instant the referenced bundle unloads.
    // Keep bundles self-contained rather than pretending disposal can leave
    // every other install untouched while sharing its objects.
    for (const edge of edges) {
      for (const endpoint of [edge.from, edge.to]) {
        if (!incomingComponentIds.has(endpoint) && this.#components.has(endpoint)) {
          throw new Error(`cross-bundle dependency reference: ${endpoint}`);
        }
      }
    }
    for (const definition of sops) {
      if (!incomingComponentIds.has(definition.componentId)) {
        if (this.#components.has(definition.componentId)) {
          throw new Error(
            `cross-bundle component reference: ${definition.componentId}`,
          );
        }
        throw new Error(`SOP ${definition.id} names unknown component: ${definition.componentId}`);
      }
      for (const checkId of [...definition.preconditions, ...definition.postconditions]) {
        if (!incomingCheckIds.has(checkId) && this.#checks.has(checkId)) {
          throw new Error(`cross-bundle check reference: ${checkId}`);
        }
      }
    }

    if (this.#components.size + components.length > limits.maxComponents) {
      throw new Error(`bundle ${bundle.tenantId} exceeds the component limit`);
    }
    if (this.#sops.size + sops.length > limits.maxSops) {
      throw new Error(`bundle ${bundle.tenantId} exceeds the SOP limit`);
    }
    if (this.#checks.size + checks.length > limits.maxChecks) {
      throw new Error(`bundle ${bundle.tenantId} exceeds the check limit`);
    }

    for (const component of components) {
      if (this.#components.has(component.id)) {
        throw new Error(`duplicate component: ${component.id}`);
      }
    }
    for (const sop of sops) {
      if (this.#sops.has(sop.id)) throw new Error(`duplicate SOP: ${sop.id}`);
    }

    // Validate the WHOLE graph, existing plus incoming, before touching state.
    const mergedComponents = [...this.#components.values(), ...components];
    const mergedEdges = [...this.#edges, ...edges];
    DependencyGraph.from(mergedComponents, mergedEdges);

    // Checks must resolve their probes, and SOPs must resolve their checks,
    // before anything is installed -- a dangling reference discovered later is
    // discovered on the recovery path.
    const mergedChecks = [...this.#checks.values(), ...checks];
    const checkRegistry = CheckRegistry.load(
      mergedChecks,
      this.deps.registeredProbeIds,
    );
    for (const definition of sops) {
      checkRegistry.resolveAll([
        ...definition.preconditions,
        ...definition.postconditions,
      ]);
    }

    const loaded = sops.map((definition) => {
      const resolved = resolveSopAuthority(definition, this.deps.authority);
      const component = components.find((candidate) => candidate.id === definition.componentId);
      const certification = certifySop(definition, checkRegistry, component);
      return {
        definition,
        authority: resolved.authority,
        ...(resolved.authorityManifestEntry === undefined
          ? {}
          : { authorityManifestEntry: resolved.authorityManifestEntry }),
        ...(resolved.authorityDowngradeReason === undefined
          ? {}
          : { authorityDowngradeReason: resolved.authorityDowngradeReason }),
        certified: certification.certified,
        certificationReasons: certification.reasons,
      } satisfies LoadedSop;
    });

    // Everything validated. Commit.
    const now = this.deps.now();
    for (const component of components) {
      this.#components.set(component.id, component);
      this.#tenantOf.set(`component:${component.id}`, bundle.tenantId);
    }
    this.#edges.push(...edges);
    for (const check of checkRegistry.ids()) {
      const definition = checkRegistry.get(check);
      if (definition !== undefined) this.#checks.set(check, definition);
    }
    for (const check of checks) {
      this.#tenantOf.set(`check:${check.id}`, bundle.tenantId);
    }
    for (const sop of loaded) {
      this.#sops.set(sop.definition.id, sop);
      this.#tenantOf.set(`sop:${sop.definition.id}`, bundle.tenantId);
      if (sop.authorityDowngradeReason !== undefined) {
        this.#observations.push(downgradeObservation(sop, now));
      }
    }

    return () => {
      for (const component of components) {
        this.#components.delete(component.id);
        this.#tenantOf.delete(`component:${component.id}`);
      }
      for (const edge of edges) {
        const at = this.#edges.findIndex(
          (e) => e.from === edge.from && e.to === edge.to,
        );
        if (at >= 0) this.#edges.splice(at, 1);
      }
      for (const sop of loaded) {
        this.#sops.delete(sop.definition.id);
        this.#tenantOf.delete(`sop:${sop.definition.id}`);
      }
      for (const check of checks) {
        this.#checks.delete(check.id);
        this.#tenantOf.delete(`check:${check.id}`);
      }
    };
  }

  component(id: string): ComponentSpec | undefined {
    return this.#components.get(id);
  }

  sop(id: string): LoadedSop | undefined {
    return this.#sops.get(id);
  }

  components(): ComponentSpec[] {
    return [...this.#components.values()];
  }

  sops(): LoadedSop[] {
    return [...this.#sops.values()];
  }

  /** Resolve the exact immutable check definitions used by an action decision. */
  checks(ids: readonly string[]): CheckDefinition[] {
    const missing = ids.filter((id) => !this.#checks.has(id));
    if (missing.length > 0) {
      throw new Error(`unknown check reference: ${missing.join(", ")}`);
    }
    return ids.map((id) => this.#checks.get(id) as CheckDefinition);
  }

  graph(): DependencyGraph {
    return DependencyGraph.from(this.components(), this.#edges);
  }

  /** Observations the registry itself produced, notably authority downgrades. */
  observations(): Observation[] {
    return [...this.#observations];
  }

  /** Whether this SOP may be selected for a mutating decision. */
  eligibleForMutation(id: string): boolean {
    const sop = this.#sops.get(id);
    if (sop === undefined) return false;
    if (!sop.definition.mutating) return false;
    return sop.certified && (sop.authority === "auto" || sop.authority === "approve");
  }
}

/**
 * A downgrade is visible, not silent. It is emitted as a `controller`-dimension
 * observation naming the SOP and the reason, so an operator sees why an SOP
 * they believe is automatic is doing nothing.
 */
function downgradeObservation(sop: LoadedSop, now: Date): Observation {
  return {
    version: 1,
    id: `obs-authority-${sop.definition.id}-${now.getTime()}`,
    componentId: sop.definition.componentId,
    probeId: "ops.authority-manifest.v1",
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    state: "degraded",
    dimension: "controller",
    value: {
      sopId: sop.definition.id,
      claimedAuthority: sop.definition.authority,
      grantedAuthority: sop.authority,
      reason: sop.authorityDowngradeReason ?? "unknown",
    },
    evidenceRefs: [`artifact://ops/authority/${sop.definition.id}`],
    parserVersion: "authority-manifest/1",
  };
}
