export function requireRepairGreen(env: NodeJS.ProcessEnv): void {
  if (env.INPUTS_DONE !== 'true' || env.INPUTS_GREEN !== 'true') {
    throw new Error('Repair must be complete and green before publication. Read implementation.md.');
  }
}

if (import.meta.main) {
  try { requireRepairGreen(process.env); console.log(JSON.stringify({ green: true })); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Repair gate failed'); process.exitCode = 1; }
}
