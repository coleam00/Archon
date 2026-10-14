export const attachmentCommands = {
  skill: {
    add: {
      args: '[path]',
      description: 'Add archon-cli into .claude/skills and .agents/skills',
    },
    install: {
      scopedOnly: true,
      args: '[path]',
      description: 'Deprecated alias for archon skill add',
    },
  },
  provider: {
    add: {
      args: '<id...>',
      description:
        'Add maintained providers matching this Archon release (connects your agent CLI or SDK)',
    },
  },
  plugin: {
    add: {
      args: '<owner/repo[/path][@tag]>',
      description:
        'Add a plugin from GitHub (default: binary plugins the latest release, workflow packs the default branch)',
    },
    update: {
      args: '<id>[@tag]',
      description:
        'Reinstall an installed plugin at a tag, or its latest release or default branch',
    },
    remove: {
      args: '<id>',
      description: 'Delete the files an installed plugin wrote',
    },
    copy: {
      args: '<id>',
      description: "Copy an installed workflow pack into this project's .archon/workflows/",
    },
    list: {
      args: '',
      description: 'Show installed plugins with tag and commit',
    },
    install: {
      scopedOnly: true,
      args: '<owner/repo[/path][@tag]>',
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
  const specs = publicAttachmentEntries(command).map(([verb, entry]) =>
    `${verb} ${entry.args}`.trimEnd()
  );
  return `Usage: archon ${command} ${specs.join(' | ')}`;
}

export function isAttachmentVerb<C extends keyof typeof attachmentCommands>(
  command: C,
  verb: string | undefined
): verb is keyof (typeof attachmentCommands)[C] & string {
  return verb !== undefined && Object.hasOwn(attachmentCommands[command], verb);
}
