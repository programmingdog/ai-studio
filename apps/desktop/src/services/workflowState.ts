// A slow query may finish after the workflow's direct poll. Never let an older
// task snapshot replace a newer one (or make newly created tasks disappear).
export function mergeTaskSnapshots<T extends { id: string; updated_at: string; created_at: string }>(current: T[], incoming: T[]): T[] {
  const tasks = new Map(current.map(task => [task.id, task]));
  for (const task of incoming) {
    const previous = tasks.get(task.id);
    if (!previous || task.updated_at > previous.updated_at) tasks.set(task.id, task);
  }
  return [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function workflowErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return workflowErrorMessage(error.message);
  const value = String(error ?? "发生未知错误");
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && "message" in parsed ? workflowErrorMessage(parsed.message) : value; }
  catch { return value; }
}
