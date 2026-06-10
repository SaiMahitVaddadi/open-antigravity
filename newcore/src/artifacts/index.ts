// ═══════════════════════════════════════════════════════════════
// OpenGravity — In-Memory Artifact Store
// Holds execution plans, logs, and verification outputs per agent.
// Future: persist to SQLite alongside audit/db layers.
// ═══════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { ArtifactData, ExecutionPlan } from '../types/index.js';

export class ArtifactStore {
  private byAgent = new Map<string, ArtifactData[]>();

  private push(artifact: ArtifactData): ArtifactData {
    const list = this.byAgent.get(artifact.agentId) ?? [];
    list.push(artifact);
    this.byAgent.set(artifact.agentId, list);
    return artifact;
  }

  createPlanArtifact(agentId: string, plan: ExecutionPlan): ArtifactData {
    return this.push({
      id: uuidv4(),
      agentId,
      type: 'execution_plan',
      title: `Execution Plan: ${plan.taskDescription}`,
      content: JSON.stringify(plan, null, 2),
      metadata: {
        stepCount: plan.steps?.length ?? 0,
        estimatedComplexity: plan.estimatedComplexity,
      },
      createdAt: Date.now(),
    });
  }

  createLogArtifact(agentId: string, title: string, content: string): ArtifactData {
    return this.push({
      id: uuidv4(),
      agentId,
      type: 'log',
      title,
      content,
      metadata: {},
      createdAt: Date.now(),
    });
  }

  createVerificationArtifact(
    agentId: string,
    title: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): ArtifactData {
    return this.push({
      id: uuidv4(),
      agentId,
      type: 'verification',
      title,
      content,
      metadata,
      createdAt: Date.now(),
    });
  }

  listByAgent(agentId: string): ArtifactData[] {
    return this.byAgent.get(agentId) ?? [];
  }
}
