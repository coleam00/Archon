import { z } from 'zod';

const legacyCheckSchema = z.object({
  context: z.string().min(1),
  app: z.object({ databaseId: z.number().int().positive() }).nullable(),
});
const legacySchema = z.object({
  errors: z.array(z.unknown()).max(0).optional(),
  data: z.object({
    repository: z.object({
      ref: z.object({
        name: z.string(),
        branchProtectionRule: z
          .object({
            requiresStatusChecks: z.boolean(),
            requiredStatusCheckContexts: z.array(z.string()),
            requiredStatusChecks: z.array(legacyCheckSchema),
          })
          .nullable(),
      }),
    }),
  }),
});
const ruleSchema = z.object({ type: z.string(), parameters: z.unknown().optional() });
const statusParametersSchema = z.object({
  required_status_checks: z.array(
    z.object({
      context: z.string().min(1),
      integration_id: z.number().int().positive().nullable().optional(),
    })
  ),
});

export interface RequiredCheck {
  context: string;
  appId: number | null;
}

// Query the exact ref so GitHub, rather than a local glob implementation, resolves
// legacy precedence. A successful null rule is absence; HTTP/GraphQL errors are not.
const legacyQuery = `query RequiredChecks($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      name
      branchProtectionRule {
        requiresStatusChecks requiredStatusCheckContexts
        requiredStatusChecks { context app { databaseId } }
      }
    }
  }
}`;

export async function requiredChecks(
  api: <T>(path: string, schema: z.ZodType<T>, body?: unknown) => Promise<T>,
  repo: string,
  baseRef: string
): Promise<RequiredCheck[]> {
  const [owner, name] = repo.split('/');
  const legacy = await api('/graphql', legacySchema, {
    query: legacyQuery,
    variables: { owner, name, ref: `refs/heads/${baseRef}` },
  });
  const ref = legacy.data.repository.ref;
  if (ref.name !== baseRef) throw new Error('Legacy policy returned a different branch');
  const result: RequiredCheck[] = [];
  const protection = ref.branchProtectionRule;
  if (protection?.requiresStatusChecks) {
    const names = new Set(protection.requiredStatusChecks.map(check => check.context));
    if (protection.requiredStatusCheckContexts.some(context => !names.has(context)))
      throw new Error('Legacy policy omitted required check identities');
    result.push(
      ...protection.requiredStatusChecks.map(check => ({
        context: check.context,
        appId: check.app?.databaseId ?? null,
      }))
    );
  }
  // This endpoint includes active inherited rules and excludes evaluate/disabled
  // rulesets. Never substitute the repository-only ruleset listing or a 404 for [].
  const path = `/repos/${repo.split('/').map(encodeURIComponent).join('/')}/rules/branches/${encodeURIComponent(baseRef)}`;
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Required-check policy enumeration exceeded its page limit');
    const rules = await api(`${path}?per_page=100&page=${String(page)}`, z.array(ruleSchema));
    for (const rule of rules) {
      if (rule.type === 'required_status_checks') {
        const parameters = statusParametersSchema.parse(rule.parameters);
        result.push(
          ...parameters.required_status_checks.map(check => ({
            context: check.context,
            appId: check.integration_id ?? null,
          }))
        );
      } else {
        // Only known rules unrelated to CI can be excluded. New rule types and
        // required workflows/deployments/scanning need evidence we do not model.
        switch (rule.type) {
          case 'creation':
          case 'update':
          case 'deletion':
          case 'required_linear_history':
          case 'required_signatures':
          case 'pull_request':
          case 'commit_message_pattern':
          case 'commit_author_email_pattern':
          case 'committer_email_pattern':
          case 'branch_name_pattern':
          case 'tag_name_pattern':
          case 'file_path_restriction':
          case 'max_file_path_length':
          case 'file_extension_restriction':
          case 'max_file_size':
            break;
          default:
            throw new Error('Required-check policy contains an unsupported rule');
        }
      }
    }
    if (rules.length < 100) break;
  }
  return [...new Map(result.map(check => [JSON.stringify(check), check])).values()];
}
