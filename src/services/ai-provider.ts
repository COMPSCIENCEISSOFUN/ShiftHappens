/**
 * AI Provider Interface (Control Layer)
 * 
 * Strategy pattern for AI-powered staff allocation.
 * Defines the contract that all AI providers must implement.
 * Allows swapping between Groq, Gemini, or any future provider
 * with a single configuration change.
*/
import type { AllocationWeights } from "@/lib/allocation-weights";

export interface StaffCandidate {
  membershipId: string;
  name: string;
  hoursWorkedToday: number;
  maxHours: number;
  certifications: string[];
  availableHours: string;
  departmentHistory: number;
}

export interface RankedStaff {
  membershipId: string;
  rank: number;
  score: number;
  explanation: string;
}

export interface AIProvider {
  /**
   * Ranks eligible staff for a task based on multiple factors.
   * Returns a sorted array with scores and explanations.
   */
  rankStaff(
    task: {
      title: string;
      department: string | null;
      priority: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      requiredHeadcount: number;
    },
    candidates: StaffCandidate[],
    weights: AllocationWeights
  ): Promise<RankedStaff[]>;
}
