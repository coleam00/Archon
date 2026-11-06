/** Validate the mission this child was handed. Bound input: INPUTS_MISSION. */
import { emit, run } from '../../.shared/io.ts';
import { parseMission } from '../../.shared/mission.ts';

run('mission parse', () => {
  const mission = parseMission(process.env.INPUTS_MISSION ?? '');
  emit({ ...mission, acceptance_text: mission.acceptance.map((c) => `- \`${c}\``).join('\n') });
});
