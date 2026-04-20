---
title: 배포 개요
description: HarnessLab을 로컬, Docker, cloud VPS에서 실행하는 배포 옵션 개요입니다.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 0
---

HarnessLab은 개발용으로 로컬에서 실행하거나, 항상 켜져 있는 운영을 위해 서버에 배포할 수 있습니다. HarnessLab은 Archon fork이므로 같은 배포 방식을 그대로 사용합니다.

## 배포 옵션

| 방식 | 적합한 용도 | 가이드 |
|--------|----------|-------|
| **Local** | 개발, 개인 사용 | [로컬 개발](/deployment/local/) |
| **Docker** | self-hosted server, CI environment | [Docker](/deployment/docker/) |
| **Cloud VPS** | 자동 HTTPS가 있는 24/7 운영 | [Cloud 배포](/deployment/cloud/) |
| **Windows** | native Windows 또는 WSL2 | [Windows](/deployment/windows/) |

## Database 옵션

| 옵션 | 설정 | 적합한 용도 |
|--------|-------|----------|
| **SQLite**(기본값) | 설정 없음, `DATABASE_URL`만 생략 | single-user, CLI 사용, 로컬 개발 |
| **Remote PostgreSQL** | hosted DB로 `DATABASE_URL` 설정 | cloud 배포, shared access |
| **Local PostgreSQL** | Docker `--profile with-db` | self-hosted, Docker 기반 setup |

SQLite는 데이터를 `~/.archon/archon.db`(Docker에서는 `/.archon/archon.db`)에 저장합니다. 첫 실행 시 자동으로 초기화됩니다.

## 테스트

| 가이드 | 대상 |
|-------|----------|
| [E2E Testing](/deployment/e2e-testing/) | 개발자와 운영자 |
| [WSL에서 E2E Testing](/deployment/e2e-testing-wsl/) | Windows 개발자 |
