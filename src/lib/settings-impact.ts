export type SettingsImpact = {
  activeStaff: number;
  openTasks: number;
  scheduledAssignments: number;
};

export function settingsImpactSummary(impact: SettingsImpact): string {
  return `This change can affect ${impact.activeStaff} active staff, ${impact.openTasks} open tasks, and ${impact.scheduledAssignments} scheduled assignments.`;
}
