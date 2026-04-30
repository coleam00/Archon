import { describe, test, expect } from 'bun:test';
import { ideUri } from './ide-uri';

describe('ideUri', () => {
  describe('default (non-WSL) form', () => {
    test('emits vscode://file/<path> when env is undefined', () => {
      expect(ideUri('/home/user/project')).toBe('vscode://file//home/user/project');
    });

    test('emits vscode://file/<path> when env.is_wsl is false', () => {
      expect(ideUri('/home/user/project', { is_wsl: false })).toBe(
        'vscode://file//home/user/project'
      );
    });

    test('falls back when is_wsl is true but wsl_distro is missing', () => {
      // Without a distro name we can't construct the WSL form — better to emit
      // the plain URI than to guess a distro that may not exist locally.
      expect(ideUri('/home/user/project', { is_wsl: true })).toBe(
        'vscode://file//home/user/project'
      );
    });

    test('normalises Windows-style backslashes', () => {
      expect(ideUri('C:\\Users\\me\\project')).toBe('vscode://file/C:/Users/me/project');
    });
  });

  describe('WSL2 form', () => {
    test('emits vscode://vscode-remote/wsl+<distro>/<path>', () => {
      expect(ideUri('/home/user/project', { is_wsl: true, wsl_distro: 'Ubuntu' })).toBe(
        'vscode://vscode-remote/wsl+Ubuntu/home/user/project'
      );
    });

    test('preserves leading slash when path already absolute', () => {
      const uri = ideUri('/home/user/project', { is_wsl: true, wsl_distro: 'Ubuntu' });
      expect(uri).toContain('/wsl+Ubuntu/home/user/project');
      expect(uri).not.toContain('/wsl+Ubuntu//home');
    });

    test('adds leading slash when path is relative-ish (defensive)', () => {
      const uri = ideUri('home/user/project', { is_wsl: true, wsl_distro: 'Ubuntu' });
      expect(uri).toBe('vscode://vscode-remote/wsl+Ubuntu/home/user/project');
    });

    test('encodes distro names that contain non-URL-safe characters', () => {
      // Hypothetical: WSL distro names with spaces / special chars
      const uri = ideUri('/home/user/x', { is_wsl: true, wsl_distro: 'My Distro' });
      expect(uri).toBe('vscode://vscode-remote/wsl+My%20Distro/home/user/x');
    });
  });
});
