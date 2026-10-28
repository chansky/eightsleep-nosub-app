export type DiagnosticSource = "cron" | "profile-save" | "test";

export interface DiagnosticProfile {
  bedTime: string;
  wakeupTime: string;
  finalStageStartTime?: string | null;
  timezone: string;
  initialSleepLevel: number;
  midStageSleepLevel: number;
  finalSleepLevel: number;
  updatedAt: string;
}

export interface DiagnosticEvent {
  at: string;
  event: string;
  details: Record<string, unknown>;
}

export interface TemperatureDiagnostic {
  id: string;
  source: DiagnosticSource;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "ok" | "error";
  profile: DiagnosticProfile;
  events: DiagnosticEvent[];
}
