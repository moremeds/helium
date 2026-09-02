import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExecutionTargetId,
  TargetProfileSchema,
  isConformant,
  type CapabilityCatalog,
  type ConformanceRecord,
  type Executor,
  type TargetProfile,
} from "@helium/core";
import type { ProviderCatalog, ProviderTarget } from "./catalog.js";

export const EntitlementCertificationSchema = z
  .object({
    certificationVersion: z.string().min(1),
    catalogSnapshotHash: z.string().min(1),
    recordedAt: z.string().datetime(),
    source: z.string().min(1),
    targets: z
      .array(
        z
          .object({
            targetRef: z.string().min(1),
            variants: z.array(z.string().min(1).nullable()).min(1).max(8),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const refs = value.targets.map((target) => target.targetRef);
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({ code: "custom", message: "duplicate certified target reference" });
    }
    for (const target of value.targets) {
      if (new Set(target.variants).size !== target.variants.length) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate certified variant for ${target.targetRef}`,
        });
      }
    }
  });

export type EntitlementCertification = z.infer<
  typeof EntitlementCertificationSchema
>;

export interface ProviderNativeVariant {
  targetRef: string;
  model: string;
  effort?: string;
  quotaDomain: string;
  executionMode?: string;
  nativeKey: string;
}

export interface ExecutorRegistryPort {
  get(targetId: ExecutionTargetId): Executor | undefined;
  register(executor: Executor, conformance: ConformanceRecord): () => void;
}

export interface RegisteredProviderTarget {
  profile: TargetProfile;
  native: ProviderNativeVariant;
  executor: Executor;
}

export type RegisteredProviderTargets = RegisteredProviderTarget[] & {
  dispose(): void;
};

export type ProviderTargetProfile = Omit<
  TargetProfile,
  "targetId"
>;

export function stableProviderTargetId(
  pluginNamespace: string,
  catalogVersion: string,
  nativeKey: string,
): ExecutionTargetId {
  const digest = createHash("sha256")
    .update(`${pluginNamespace}\0${catalogVersion}\0${nativeKey}`)
    .digest("hex")
    .slice(0, 32);
  return ExecutionTargetId(`target-${digest}`);
}

function validateVariant(target: ProviderTarget, variant: string | null): void {
  if (!target.enabled) {
    throw new Error(`target is not enabled by provider catalog: ${target.targetRef}`);
  }
  if (!target.effort.supported) {
    if (variant !== null) {
      throw new Error(`effort unsupported by target ${target.targetRef}`);
    }
    return;
  }
  if (variant === null || !target.effort.options.includes(variant)) {
    throw new Error(`uncertified effort ${String(variant)} for ${target.targetRef}`);
  }
}

export function registerCertifiedTargets(input: {
  pluginNamespace: string;
  catalog: ProviderCatalog & { snapshotHash: string };
  certification: EntitlementCertification;
  targetProfile: ProviderTargetProfile;
  capabilityCatalog: CapabilityCatalog;
  executorRegistry: ExecutorRegistryPort;
  conformanceFor(targetId: ExecutionTargetId): ConformanceRecord;
  createExecutor(
    targetId: ExecutionTargetId,
    native: ProviderNativeVariant,
  ): Executor;
}): RegisteredProviderTargets {
  const certification = EntitlementCertificationSchema.parse(input.certification);
  if (certification.catalogSnapshotHash !== input.catalog.snapshotHash) {
    throw new Error("certification does not match provider catalog snapshot");
  }

  const byRef = new Map(
    input.catalog.targets.map((target) => [target.targetRef, target]),
  );
  const staged: RegisteredProviderTarget[] = [];
  const conformanceByTarget = new Map<string, ConformanceRecord>();
  for (const certified of certification.targets) {
    const target = byRef.get(certified.targetRef);
    if (target === undefined) {
      throw new Error(`certification names unknown target: ${certified.targetRef}`);
    }
    for (const variant of certified.variants) {
      validateVariant(target, variant);
      const nativeKey = `${target.targetRef}|effort=${variant ?? "none"}`;
      const targetId = stableProviderTargetId(
        input.pluginNamespace,
        input.catalog.catalogVersion,
        nativeKey,
      );
      const profile = TargetProfileSchema.parse({
        targetId,
        ...input.targetProfile,
      }) as TargetProfile;
      const native: ProviderNativeVariant = {
        targetRef: target.targetRef,
        model: target.model,
        ...(variant === null ? {} : { effort: variant }),
        quotaDomain: target.quotaDomain,
        nativeKey,
      };
      const executor = input.createExecutor(targetId, native);
      const conformance = input.conformanceFor(targetId);
      if (String(executor.targetId) !== String(targetId)) {
        throw new Error(`executor target mismatch for ${targetId}`);
      }
      if (String(conformance.targetId) !== String(targetId)) {
        throw new Error(`conformance target mismatch for ${targetId}`);
      }
      if (!isConformant(executor.isolationClass, conformance)) {
        throw new Error(`executor ${targetId} exceeds its conformance proof`);
      }
      if (input.capabilityCatalog.get(targetId) !== undefined) {
        throw new Error(`duplicate target: ${targetId}`);
      }
      if (input.executorRegistry.get(targetId) !== undefined) {
        throw new Error(`duplicate executor for target: ${targetId}`);
      }
      staged.push({ profile, native, executor });
      conformanceByTarget.set(String(targetId), conformance);
    }
  }
  if (new Set(staged.map((entry) => entry.profile.targetId)).size !== staged.length) {
    throw new Error("certification expands to duplicate opaque targets");
  }

  const disposers: Array<() => void> = [];
  try {
    for (const entry of staged) {
      disposers.push(input.capabilityCatalog.register(entry.profile));
      disposers.push(
        input.executorRegistry.register(
          entry.executor,
          conformanceByTarget.get(String(entry.profile.targetId))!,
        ),
      );
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }

  const registered = staged as RegisteredProviderTargets;
  let disposed = false;
  Object.defineProperty(registered, "dispose", {
    enumerable: false,
    value: () => {
      if (disposed) return;
      disposed = true;
      for (const dispose of [...disposers].reverse()) dispose();
    },
  });
  return registered;
}
