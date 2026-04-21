---
title: DX 특이사항
description: Archon 코드베이스에서 작업할 때 알아둘 개발 경험 특이사항과 우회 방법.
category: contributing
audience: [developer]
status: current
sidebar:
  order: 6
---

개발 중 자주 마주치는 특이사항과 우회 방법을 정리합니다.

## Bun 로그 생략

repo root에서 `bun dev`를 실행하면 Bun의 `--filter` 때문에 로그가 축약됩니다.

```
@harneeslab/server dev $ bun --watch src/index.ts
│ [129 lines elided]
│ [Hono] Server listening on port 3090
└─ Running...
```

**전체 로그를 보려면** server 패키지에서 직접 실행하세요.

```bash
cd packages/server && bun --watch src/index.ts
```

또는 다음처럼 실행합니다.

```bash
bun --cwd packages/server run dev
```

참고: root의 `bun dev`는 hot reload 경로 문제를 해결하기 위해 `--filter`를 사용하며, 그 대신 로그가 압축됩니다.

## `mock.module()` 오염

Bun의 `mock.module()`은 process-global이며 되돌릴 수 없습니다. `mock.restore()`로도 원복되지 않습니다.

- `mock.module()` 정리를 위해 `afterAll(() => mock.restore())`를 추가하지 마세요. 효과가 없습니다.
- 다른 테스트 파일이 직접 import하는 내부 모듈에는 `spyOn()`을 사용하세요. 예: `spyOn(git, 'checkout')`. spy에는 `spy.mockRestore()`가 동작합니다.
- 다른 테스트 파일이 서로 다른 구현으로 `mock.module()`하는 module path를 다시 `mock.module()`하지 마세요.
- `mock.module()`을 쓰는 새 테스트 파일을 추가할 때는, 충돌하는 파일과 별도의 `bun test` 호출로 실행되도록 해당 package.json test script를 구성하세요.

## Worktree 포트 할당

Worktree는 포트를 자동 할당합니다. 범위는 3190-4089이고, path 기반 hash를 사용합니다. 같은 worktree는 항상 같은 포트를 받습니다.

- Main repo 기본값은 3090입니다.
- Override: `PORT=4000 bun dev`
- 같은 worktree는 항상 같은 포트를 받습니다. 즉 deterministic합니다.

## `bun run test` vs `bun test`

**repo root에서 `bun test`를 직접 실행하지 마세요.** 모든 패키지의 테스트 파일을 찾아 한 프로세스에서 실행하므로, mock 오염으로 약 135개의 실패가 발생합니다.

항상 `bun run test`를 사용하세요. 이 명령은 패키지별 격리를 위해 `bun --filter '*' test`를 사용합니다.
