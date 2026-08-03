#!/usr/bin/env bun
// Clean: legitimate fetch to github.com (allowlisted host)
const res = await fetch('https://github.com/coleam00/Archon/releases/latest');
const data = (await res.json()) as { tag_name: string };
console.log(JSON.stringify({ latest: data.tag_name }));
