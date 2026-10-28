import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentCredentialStatus, AgentCredentials } from '../skills';
import { AgentCredentialCard } from './AgentCredentialCard';

function renderAnthropicConnection(connected: 'oauth' | 'api_key'): string {
  const anthropic: AgentCredentialStatus = {
    vendor: 'anthropic',
    displayName: 'Anthropic',
    kinds: ['api_key'],
    connected,
    connectionConsumed: connected === 'api_key',
    subscriptionAvailable: false,
    installEnv: false,
    usable: connected === 'api_key',
  };
  const agent: AgentCredentials = {
    id: 'pi',
    displayName: 'Pi',
    catalog: 'static',
    ready: anthropic.usable,
    credentials: [
      anthropic,
      {
        vendor: 'openai',
        displayName: 'OpenAI',
        kinds: ['api_key'],
        connected: null,
        connectionConsumed: false,
        subscriptionAvailable: false,
        installEnv: false,
        usable: false,
      },
    ],
  };
  return renderToStaticMarkup(
    <AgentCredentialCard
      agent={agent}
      connections={[{ provider: 'anthropic', kind: connected, label: null }]}
      connectEnabled
      piModelCounts={new Map()}
    />
  );
}

describe('AgentCredentialCard connection ownership', () => {
  test('Pi explains a subscription used by another agent without offering Disconnect', () => {
    const html = renderAnthropicConnection('oauth');

    expect(html).toContain(
      'subscription used by another agent · to use Anthropic here, set its API key in the install or codebase env'
    );
    expect(html).not.toContain('>Disconnect</button>');
  });

  test('Pi offers Disconnect for its consumed API key', () => {
    const html = renderAnthropicConnection('api_key');

    expect(html).toContain('API key connected');
    expect(html).toContain('>Disconnect</button>');
    expect(html).not.toContain('used by another agent');
  });
});
