/**
 * A forge plugin for a non-GitHub tracker, for `sdlc-forge-delivery.test.ts`. It parses
 * requests and responses with the host's own schemas, so a drift in the protocol fails here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  contentDigest,
  forgeRequestSchema,
  forgeResponseSchema,
  type ForgeWorkItemRecord,
} from '../../packages/forge/src/operations';
const metadata = {
  protocol: 1,
  name: 'tracker',
  version: '1',
  forge: 'other',
  hosts: ['tracker.example'],
  capabilities: [
    'workitem.view',
    'workitem.create',
    'workitem.label.add',
    'workitem.label.remove',
    'repo.labels.list',
    'repo.label.ensure',
  ],
  token_env: [],
};
if (process.argv.includes('metadata')) {
  process.stdout.write(JSON.stringify(metadata));
  process.exit(0);
}
const statePath = process.argv[process.argv.indexOf('--state') + 1];
const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
  issues: { number: number; title: string; body: string; labels: string[] }[];
  labels: { name: string; color: string; description: string }[];
  operations: string[];
  writes: string[];
};
const request = forgeRequestSchema.parse(await Bun.stdin.json());
state.operations.push(request.op);
const repo =
  'repo' in request
    ? request.repo
    : 'ref' in request
      ? request.ref.repo
      : 'subject' in request
        ? request.subject.ref.repo
        : undefined;
if (repo?.host !== 'tracker.example' || repo.path !== 'group/team/project')
  throw new Error('unexpected qualified target');
const item = (number: number): ForgeWorkItemRecord => ({
  ref: { repo, number },
  kind: 'issue',
  url: `https://${repo.host}/${repo.path}/items/${String(number)}`,
  state: 'open',
});
let value: unknown;
switch (request.op) {
  case 'workitem.view': {
    const issue = state.issues.find(row => row.number === request.ref.number);
    if (!issue) throw new Error('missing issue');
    value = { ...item(issue.number), title: issue.title, body: issue.body, labels: issue.labels };
    break;
  }
  case 'repo.labels.list':
    value = { repo, labels: state.labels.map(({ name }) => ({ name })) };
    break;
  case 'repo.label.ensure': {
    let label = state.labels.find(row => row.name === request.name);
    const changed = !label;
    if (!label) {
      label = { name: request.name, color: request.color, description: request.description };
      state.labels.push(label);
      state.writes.push(request.op);
    }
    value = {
      target: repo,
      outcome: 'applied',
      changed,
      label: {
        name: label.name,
        color: label.color,
        descriptionDigest: contentDigest(label.description),
      },
    };
    break;
  }
  case 'workitem.create': {
    let issue = state.issues.find(row => row.body.split('\n')[0] === request.marker);
    const changed = !issue;
    if (!issue) {
      issue = {
        number: state.issues.length + 1,
        title: request.title,
        body: request.body,
        labels: [],
      };
      state.issues.push(issue);
      state.writes.push(request.op);
    }
    value = {
      target: repo,
      outcome: 'applied',
      changed,
      workitem: item(issue.number),
      markerDigest: contentDigest(request.marker),
      titleDigest: contentDigest(issue.title),
      bodyDigest: contentDigest(issue.body),
    };
    break;
  }
  case 'workitem.label.add':
  case 'workitem.label.remove': {
    const issue = state.issues.find(row => row.number === request.subject.ref.number);
    if (!issue || !state.labels.some(label => label.name === request.name))
      throw new Error('invalid label target');
    const has = issue.labels.includes(request.name);
    const adding = request.op === 'workitem.label.add';
    const changed = adding !== has;
    if (changed) {
      issue.labels = adding
        ? [...issue.labels, request.name]
        : issue.labels.filter(name => name !== request.name);
      state.writes.push(request.op);
    }
    value = {
      target: request.subject.ref,
      outcome: 'applied',
      changed,
      workitem: item(issue.number),
      labels: issue.labels,
    };
    break;
  }
  default:
    throw new Error('unsupported operation');
}
writeFileSync(statePath, JSON.stringify(state));
const response = forgeResponseSchema.parse({
  operationId: request.operationId,
  ok: true,
  result: { op: request.op, value },
});
process.stdout.write(JSON.stringify(response));
