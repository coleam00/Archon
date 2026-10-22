import type { CheckResult } from './doctor-check';

export async function checkGitHubApp(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  try {
    const { loadGitHubAppConfig } = await import('@archon/core');
    if (loadGitHubAppConfig(env)) {
      return {
        label: 'GitHub App',
        status: 'pass',
        message: 'App mode configured (local configuration valid; GitHub access not checked)',
      };
    }
  } catch (error) {
    return {
      label: 'GitHub App',
      status: 'fail',
      message: error instanceof Error ? error.message : 'Invalid GitHub App configuration.',
    };
  }
  return { label: 'GitHub App', status: 'skip', message: 'App mode not configured' };
}

export async function checkSlack(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Slack';
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    return { label, status: 'skip', message: 'no SLACK_BOT_TOKEN set' };
  }
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body.ok) {
      return { label, status: 'pass', message: 'auth.test OK' };
    }
    return { label, status: 'fail', message: `auth.test rejected: ${body.error ?? 'unknown'}` };
  } catch (err) {
    // Network errors → skip, not fail — best-effort by design.
    return {
      label,
      status: 'skip',
      message: `ping skipped (${(err as Error).message})`,
    };
  }
}

export async function checkTelegram(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Telegram';
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { label, status: 'skip', message: 'no TELEGRAM_BOT_TOKEN set' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (body.ok) {
      return { label, status: 'pass', message: 'getMe OK' };
    }
    return {
      label,
      status: 'fail',
      message: `getMe rejected: ${body.description ?? 'unknown'}`,
    };
  } catch (err) {
    return {
      label,
      status: 'skip',
      message: `ping skipped (${(err as Error).message})`,
    };
  }
}
