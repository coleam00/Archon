export const attachmentCommands = {
  skill: {
    add: {
      spec: 'skill add [path]',
      description: 'Add archon-cli into .claude/skills and .agents/skills',
    },
    install: {
      scopedOnly: true,
      spec: 'skill install [path]',
      description: 'Deprecated alias for archon skill add',
    },
  },
  provider: {
    add: {
      spec: 'provider add <id...>',
      description:
        'Add maintained providers matching this Archon release (connects your agent CLI or SDK)',
    },
  },
  plugin: {
    add: {
      spec: 'plugin add <owner/repo[/path][@tag]>',
      description:
        'Add a plugin from GitHub (default: binary plugins the latest release, workflow packs the default branch)',
    },
    update: {
      spec: 'plugin update <id>[@tag]',
      description:
        'Reinstall an installed plugin at a tag, or its latest release or default branch',
    },
    remove: {
      spec: 'plugin remove <id>',
      description: 'Delete the files an installed plugin wrote',
    },
    copy: {
      spec: 'plugin copy <id>',
      description: "Copy an installed workflow pack into this project's .archon/workflows/",
    },
    list: {
      spec: 'plugin list',
      description: 'Show installed plugins with tag and commit',
    },
    install: {
      scopedOnly: true,
      spec: 'plugin install <owner/repo[/path][@tag]>',
      description: 'Deprecated alias for archon plugin add',
    },
  },
} as const;

export function publicAttachmentEntries(command: keyof typeof attachmentCommands) {
  return Object.entries(attachmentCommands[command]).filter(
    ([, entry]) => !Object.hasOwn(entry, 'scopedOnly')
  );
}

export function attachmentUsage(command: keyof typeof attachmentCommands): string {
  const specs = publicAttachmentEntries(command).map(([, entry], index) =>
    index === 0 ? entry.spec : entry.spec.slice(command.length + 1)
  );
  return `Usage: archon ${specs.join(' | ')}`;
}

export function isAttachmentVerb<C extends keyof typeof attachmentCommands>(
  command: C,
  verb: string | undefined
): verb is keyof (typeof attachmentCommands)[C] & string {
  return verb !== undefined && Object.hasOwn(attachmentCommands[command], verb);
}
